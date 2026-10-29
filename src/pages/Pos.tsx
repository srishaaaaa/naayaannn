import { birthdayService } from '../services/birthdayService'
import { useEffect, useMemo, useRef, useState, useCallback, type FormEvent } from 'react'
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Link, useNavigate } from 'react-router-dom'
import {
  Search, Trash2, Plus, Receipt, Printer,
  RefreshCw, ShoppingBag, MessageCircle, Eye,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  Wifi, WifiOff, Layers, X, ChevronDown, Power,
  Edit2, AlertCircle, Check, User, CalendarDays, PackagePlus, List, Clock
} from 'lucide-react'
import { useProductStore, useVariantStore, useAdminAuthStore, type Product } from '../store/store'
import { useNavigationStore } from '../store/navigationStore'
import { barcodeService } from '../services/barcodeService'
import { normalizeBarcode } from '../lib/barcode'
import { Invoice, type InvoiceProps } from '../components/Invoice'
import InvoicePreviewModal from '../components/print/InvoicePreviewModal'
import PrintSettingsModal from '../components/print/PrintSettingsModal'
import { invoicePdfFromProps, printBill } from '../lib/billPrint'
import CatalogModal from '../components/CatalogModal'
import AddProductModal from '../components/AddProductModal'
import { invoicePdfFileFromElement } from '../lib/invoicePdf'
import { uploadInvoicePdf } from '../lib/storage'
import { createOrderWithStock } from '../services/orderService'
import { createAdvanceOrder, getAdvanceOrderHistory, type AdvanceOrder, type AdvancePaymentMethod } from '../services/advanceOrderService'
import { advanceReceiptProps } from '../lib/advanceInvoice'
import SplitPaymentInputs from '../components/common/SplitPaymentInputs'
import { emptySplitInput, formatPaymentLabel, splitInputToDetails, splitTotal, type SplitInputValue } from '../lib/payments'
import {
  buildStructuredOrderItem,
  calculateLineTotal,
  formatCurrency,
  formatQuantityDisplay,
  formatInvoiceNo,
  variantOfferPrice,
} from '../lib/retail'
import { buildProfessionalWhatsAppMessage, buildAdvanceDepositWhatsAppMessage, publicInvoiceUrl } from '../lib/whatsappMessage'
import { normalizePhone, toWhatsAppUrl } from '../lib/phone'
import { useLangStore } from '../store/langStore'
import { fetchVariantsByProduct, type ProductVariant } from '../services/variantService'
import { BarcodeScannerInput, type ScannedItemPayload } from '../components/pos/BarcodeScannerInput'
import { db, isDatabaseConfigured } from '../lib/db'
import { createPortal } from 'react-dom'

// ── Types ──────────────────────────────────────────────────────────────────
type PosItem = Product & {
  qty: number
  selectedUnit: string
  basePrice: number | string
  lineTotal: number
  source?: 'catalogue' | 'manual'
  note?: string | null
  variantId?: string         // product_variants.id
  variantName?: string       // snapshot
  parentProductId?: string   // products.id (before synthetic override)
}

type InvoiceSnap = {
  id: string
  invoiceNo: string
  orderType: 'online_request' | 'pos_sale' | 'manual_sale'
  date: string
  items: PosItem[]
  subtotal: number
  shipping: number
  couponCode?: string
  couponDiscount: number
  manualDiscountAmount: number
  manualDiscountType: 'flat' | 'percent'
  manualDiscountValue: number
  gstAmount: number
  total: number
  customerName: string
  phone: string
  address: string
  amountReceived: number
  balanceReturned: number
  paymentMode: string
  paymentMethod?: string
  invoicePdfUrl?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────
/** Actual rate (MRP) when a catalogue product is being billed at its offer price. */
const offerMrp = (item: PosItem): number | null => {
  const mrp = Number(item.price) || 0
  const pay = Number(item.basePrice) || 0
  return item.source !== 'manual' && item.offerPrice && pay > 0 && pay < mrp ? mrp : null
}

/** "MRP ₹1,000 · 10% off (−₹100)" under an item that has a product offer. */
function OfferLine({ item }: { item: PosItem }) {
  const mrp = offerMrp(item)
  if (!mrp) return null
  const pay = Number(item.basePrice) || 0
  const off = Math.round((mrp - pay) * 100) / 100
  const pct = Math.round((off / mrp) * 1000) / 10
  return (
    <span className="ml-2 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold text-gray-500">
      <span className="line-through">{formatCurrency(mrp)}</span>
      <span className="rounded bg-amber-50 px-1.5 py-0.5 font-bold text-amber-700">{pct}% off · −{formatCurrency(off)}</span>
    </span>
  )
}

// Returns the product ID if it looks like a real DB identifier (UUID or numeric),
// or null for synthetic/manual IDs like "manual-<timestamp>".
const toProductId = (v: string | number): string | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  // Accept pure-numeric strings (BIGINT products.id)
  if (/^\d+$/.test(s)) return s
  // Accept UUID format (product_variants.id and UUID-keyed products)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) return s
  // Anything else (e.g. "manual-1786182383886") is a client-side synthetic ID — not a real DB row
  return null
}

const makePosItem = (p: Product, qty?: number): PosItem => {
  const basePrice = p.offerPrice || p.price
  const q = Math.max(1, Math.round(qty ?? 1))
  const packLabel = p.predefinedOptions[0]?.label ?? p.unitLabel
  const isUnregistered = p.category === 'Unregistered'
  return {
    ...p,
    qty: q,
    selectedUnit: packLabel,
    basePrice,
    lineTotal: calculateLineTotal(q, p.unitType, p.baseQuantity, basePrice),
    source: isUnregistered ? 'manual' : (p.barcode ? 'catalogue' : 'catalogue'),
    stock: isUnregistered ? 999999 : p.stock,
    stockQuantity: isUnregistered ? 999999 : p.stockQuantity,
  }
}

/** Drops untouched custom lines (no name, no price) so adding a real product doesn't leave an empty box behind. */
const withoutBlankCustom = (cur: PosItem[]) =>
  cur.filter(i => !(i.source === 'manual' && !String(i.name || '').trim() && !Number(i.basePrice)))

/** " (2.5%)" – a GST part as a share of the taxable value; empty when there is nothing to tax. */
const gstPctLabel = (part: number, taxable: number) =>
  taxable > 0 ? ` (${Math.round((part / taxable) * 10000) / 100}%)` : ''

// item.name may already end with the variant ("Shirt - XS"); never append it twice
const itemDisplayName = (item: { name: string; variantName?: string }) =>
  item.variantName && !item.name.trim().toLowerCase().endsWith(item.variantName.trim().toLowerCase())
    ? `${item.name} - ${item.variantName}`
    : item.name

const recalc = (item: PosItem, nextQty: number): PosItem => {
  const q = Math.max(1, Math.round(nextQty))
  return { ...item, qty: q, lineTotal: calculateLineTotal(q, item.unitType, item.baseQuantity, item.basePrice) }
}


// ── Billing panel styles ───────────────────────────────────────────────────
const posLabel = 'mb-2 block text-[10px] font-bold uppercase tracking-[0.15em] text-[#000000]'
const posSideLabel = 'mb-2 block text-[10px] font-bold uppercase tracking-[0.15em] text-[#000000]'
const posInput = 'w-full min-w-0 rounded-lg border border-black/10 bg-white px-4 py-2.5 text-sm font-semibold text-[#000000] placeholder:text-[#000000]/70 focus:border-primary focus:outline-none'
const posToolBtn = 'inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-white px-3.5 py-2 text-[10px] font-bold uppercase tracking-wider text-[#000000] transition-colors hover:bg-gray-50 disabled:opacity-40'

// ── Category colours ───────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
const CAT_COLOR: Record<string, string> = {
  'Bridal Shawl': '#9CA3AF', 'Shawl': '#D97706', 'Dress': '#6B7280',
  'Saree': '#DC2626', 'Tops': '#92400E',
  'Bottoms': '#B45309', 'Accessories': '#6B7280',
}

// ══════════════════════════════════════════════════════════════════════════
type PosProps = {
  isEmbedded?: boolean
  externalScannedCode?: string | null
  onCodeProcessed?: () => void
}

export default function Pos(props: PosProps = {}) {
  const embeddedMode = Boolean(props.isEmbedded)
  const { products, fetchProducts } = useProductStore()
  const { getVariants, fetchVariants, refetchVariants } = useVariantStore()
  const { lang } = useLangStore()
  const l = (en: string, ta: string) => lang === 'ta' ? ta : en
  const navigate = useNavigate()
  const { logout, role } = useAdminAuthStore()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [billingAdjOpen, setBillingAdjOpen] = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [search, setSearch] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [activeCategory, setActiveCategory] = useState('All')
  const [items, setItems] = useState<PosItem[]>([])
  const [customer, setCustomer] = useState({ name: '', phone: '', address: '' })
  const [remarks, setRemarks] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [birthDate, setBirthDate] = useState('') // YYYY-MM-DD, optional
  const [billingDate, setBillingDate] = useState('') // '' = use current date/time
  const [paymentType, setPaymentType] = useState<'cash' | 'qr' | 'card' | 'split'>('cash')
  const [splitForm, setSplitForm] = useState<SplitInputValue>(emptySplitInput())
  const [depositSplit, setDepositSplit] = useState<SplitInputValue>(emptySplitInput())
  const [saving, setSaving] = useState(false)
  const [shipping, setShipping] = useState<string>('0')
  const [couponInput, setCouponInput] = useState('')
  const [couponLoading, setCouponLoading] = useState(false)
  const [couponError, setCouponError] = useState('')
  const [availableCoupons, setAvailableCoupons] = useState<{code: string}[]>([])
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; percentage: number; minOrderValue: number; discount?: number } | null>(null)
  const [manualDiscountType, setManualDiscountType] = useState<'flat' | 'percent'>('flat')
  const [manualDiscountValue, setManualDiscountValue] = useState('')
  const [error, setError] = useState('')
  const [invoice, setInvoice] = useState<InvoiceSnap | null>(null)
  const [billPrintOpen, setBillPrintOpen] = useState(false)
  const [billPreviewOpen, setBillPreviewOpen] = useState(false)
  const [depositPrintProps, setDepositPrintProps] = useState<InvoiceProps | null>(null)
  const invoicePdfRef = useRef<HTMLDivElement>(null)
  const pdfSavedFor = useRef<string | null>(null)
  const [cashReceived, setCashReceived] = useState<string>('')
  const [mobilePanelView, setMobilePanelView] = useState<'catalogue' | 'bill'>('catalogue')
  const [ordermode, setOrdermode] = useState<'online' | 'offline'>('offline')
  const [variantPickerProduct, setVariantPickerProduct] = useState<Product | null>(null)
  const [availableVariants, setAvailableVariants] = useState<ProductVariant[]>([])
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null)
  const [variantPickerQty, setVariantPickerQty] = useState(1)
  const [billGstEnabled, setBillGstEnabled] = useState(false)
  const [gstInput, setGstInput] = useState('')
  const [gstType, setGstType] = useState<'percent' | 'flat'>('percent')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [addToCatalogOpen, setAddToCatalogOpen] = useState(false)
  const [depositOpen, setDepositOpen] = useState(false)
  const [depositCreated, setDepositCreated] = useState<AdvanceOrder | null>(null)
  const [depositForm, setDepositForm] = useState({ amount: '', expectedDeliveryDate: '', paymentMethod: 'cash' as AdvancePaymentMethod, address: '', remarks: '', referenceNumber: '' })
  const [dbCategories, setDbCategories] = useState<string[]>([])
  const [priceEditModal, setPriceEditModal] = useState<{
    isOpen: boolean
    item: PosItem | null
    newPrice: string
    isSubmitting: boolean
    error: string
  }>({
    isOpen: false,
    item: null,
    newPrice: '',
    isSubmitting: false,
    error: '',
  })
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Always load the current catalogue when billing opens (never a list cached earlier in the session)
    void fetchProducts(true)
    void refetchVariants()
    if (!isDatabaseConfigured) return

    db.from('coupons').select('code').eq('is_active', true).order('created_at', { ascending: false }).limit(20)
      .then(({ data, error }) => {
        if (error) console.error('Failed to fetch coupons', error)
        else if (data) setAvailableCoupons(data)
      })

    const productChannel = db.channel('pos-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => void fetchProducts(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_variants' }, () => void refetchVariants())
      .subscribe()

    // Load active categories in sort_order
    db.from('categories').select('name_en').eq('is_active', true).order('sort_order')
      .then(({ data }) => {
        if (data) setDbCategories(data.map(c => c.name_en as string))
      })

    return () => { void db.removeChannel(productChannel) }
  }, [fetchProducts, refetchVariants])

  // ── Derived data ──────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const categories = useMemo(() => {
    // Use DB active categories in sort_order; fall back to product categories if DB returns nothing
    if (dbCategories.length > 0) return ['All', ...dbCategories]
    const cats = Array.from(new Set(products.filter(p => p.isActive).map(p => p.category))).filter(Boolean)
    return ['All', ...cats]
  }, [dbCategories, products])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let src = products.filter(p => p.isActive)
    if (activeCategory !== 'All') src = src.filter(p => p.category === activeCategory)
    if (q) src = src.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.nameTa || '').toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
    )
    return src.slice(0, 120)
  }, [products, search, activeCategory])

  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0)
  const isValidCoupon = appliedCoupon && subtotal >= (appliedCoupon.minOrderValue || 0)
  const couponDiscount = isValidCoupon
    ? ((appliedCoupon.percentage || 0) > 0
        ? Math.round((subtotal * (appliedCoupon.percentage || 0) / 100) * 100) / 100
        : (appliedCoupon.discount || 0))
    : 0
  const manualDiscountNumeric = Math.max(0, Number(manualDiscountValue) || 0)
  // The manual discount comes off the total after the coupon, and the two can never exceed the subtotal
  const afterCoupon = Math.max(0, subtotal - couponDiscount)
  const manualDiscountAmount = Math.min(
    afterCoupon,
    manualDiscountType === 'percent'
      ? Math.max(0, Math.round((afterCoupon * manualDiscountNumeric / 100) * 100) / 100)
      : manualDiscountNumeric,
  )

  const discountedSubtotal = Math.max(0, subtotal - couponDiscount - manualDiscountAmount)

  const totalGst = billGstEnabled
    ? (gstType === 'percent'
      ? Math.max(0, Math.round((discountedSubtotal * (Math.max(0, Number(gstInput) || 0) / 100)) * 100) / 100)
      : Math.max(0, Number(gstInput) || 0))
    : 0
  const total = Math.max(0, discountedSubtotal + (Number(shipping || 0) || 0) + totalGst)

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const itemQtyMap = useMemo(() => {
    const m: Record<string | number, number> = {}
    items.forEach(i => { m[i.id] = i.qty })
    return m
  }, [items])

  // ── Cart actions ──────────────────────────────────────────────────────
  const addItem = async (product: Product, specificVariant?: ProductVariant) => {
    setError('')
    setMobilePanelView('catalogue')

    if (specificVariant) {
      const variantProduct: Product = {
        ...product,
        id: specificVariant.id,
        name: `${product.name} - ${specificVariant.variantName}`,
        price: specificVariant.price,
        offerPrice: variantOfferPrice(product.price, product.offerPrice, specificVariant.price),
        stock: specificVariant.stock,
        stockQuantity: specificVariant.stock,
        hasVariants: false,
        unitType: 'unit',
        baseQuantity: 1,
        unitLabel: specificVariant.sizeLabel || specificVariant.variantName || 'piece',
      }
      setItems(prev => {
        const cur = withoutBlankCustom(prev)
        const ex = cur.find(i => (i.variantId === specificVariant.id || String(i.id) === String(specificVariant.id)))
        if (!ex) {
          const item = makePosItem(variantProduct, 1)
          item.variantId = specificVariant.id
          item.variantName = specificVariant.variantName
          item.parentProductId = String(product.id)
          return [item, ...cur]
        }
        return cur.map(i => (i.variantId === specificVariant.id || String(i.id) === String(specificVariant.id)) ? recalc(i, i.qty + 1) : i)
      })
      return
    }

    // If product has variants, check its variants from DB or store
    if (product.hasVariants) {
      try {
        let vars = getVariants(String(product.id))
        if (!vars || vars.length === 0) {
          vars = await fetchVariantsByProduct(String(product.id))
        }

        if (vars && vars.length > 1) {
          // Multiple variants: open variant picker
          setAvailableVariants(vars)
          setVariantPickerProduct(product)
          setSelectedVariant(vars[0])
          setVariantPickerQty(1)
          return
        } else if (vars && vars.length === 1) {
          // Only 1 variant: add it directly
          void addItem(product, vars[0])
          return
        }
      } catch (err) {
        console.warn('Failed to load variants for product:', err)
      }
    }

    // Standard non-variant product
    setItems(prev => {
      const cur = withoutBlankCustom(prev)
      const ex = cur.find(i => String(i.id) === String(product.id))
      if (!ex) return [makePosItem(product), ...cur]
      return cur.map(i => String(i.id) === String(product.id) ? recalc(i, i.qty + 1) : i)
    })
  }

  const addVariantToItems = () => {
    if (!variantPickerProduct || !selectedVariant) return
    setError('')
    const variantProduct: Product = {
      ...variantPickerProduct,
      id: selectedVariant.id,
      name: `${variantPickerProduct.name} - ${selectedVariant.variantName}`,
      price: selectedVariant.price,
      offerPrice: variantOfferPrice(variantPickerProduct.price, variantPickerProduct.offerPrice, selectedVariant.price),
      stock: selectedVariant.stock,
      stockQuantity: selectedVariant.stock,
      hasVariants: false,
      unitType: 'unit',
      baseQuantity: 1,
      unitLabel: selectedVariant.sizeLabel || variantPickerProduct.unitLabel || 'piece',
    }
    const addQty = Math.max(1, variantPickerQty)
    setItems(prev => {
      const cur = withoutBlankCustom(prev)
      const ex = cur.find(i => (i.variantId === selectedVariant.id || String(i.id) === String(selectedVariant.id)))
      if (!ex) {
        const item = makePosItem(variantProduct, addQty)
        item.variantId = selectedVariant.id
        item.variantName = selectedVariant.variantName
        item.parentProductId = String(variantPickerProduct.id)
        return [item, ...cur]
      }
      return cur.map(i => (i.variantId === selectedVariant.id || String(i.id) === String(selectedVariant.id)) ? recalc(i, i.qty + addQty) : i)
    })
    setVariantPickerProduct(null)
    setSelectedVariant(null)
    setVariantPickerQty(1)
    setAvailableVariants([])
    setMobilePanelView('catalogue')
  }

  // Barcode scanner item handler (Consecutive scan increments cart quantity)
  const handleScannedItem = (scanned: ScannedItemPayload) => {
    setError('')
    const targetId = scanned.variant_id ? scanned.variant_id : scanned.product_id

    setItems(prev => {
      const cur = withoutBlankCustom(prev)
      const ex = cur.find(i => (scanned.variant_id ? i.variantId === scanned.variant_id : i.id === scanned.product_id))
      if (!ex) {
        const item = makePosItem({
          id: targetId,
          name: scanned.product_name,
          nameTa: scanned.name_ta || undefined,
          tamilName: scanned.name_ta || undefined,
          category: scanned.category || 'Apparel',
          remedy: [],
          price: scanned.price,
          offerPrice: scanned.offer_price || null,
          stock: scanned.stock,
          stockQuantity: scanned.stock,
          hasVariants: false,
          unitType: 'unit',
          unitLabel: scanned.variant_name || 'piece',
          baseQuantity: 1,
          stockUnit: 'piece',
          allowDecimalQuantity: false,
          predefinedOptions: [],
          isActive: true,
          sortOrder: 0,
          unit: '1pc',
          rating: 5,
          description: '',
          benefits: '',
          image: scanned.image_url || '/product-placeholder.svg',
          imageUrl: scanned.image_url || '/product-placeholder.svg',
          barcode: scanned.barcode,
        }, 1)
        item.variantId = scanned.variant_id || undefined
        item.variantName = scanned.variant_name || undefined
        item.parentProductId = String(scanned.product_id)
        return [...cur, item]
      }

      // Existing item: increment quantity by 1
      return cur.map(i => {
        if ((scanned.variant_id && i.variantId === scanned.variant_id) || (!scanned.variant_id && i.id === scanned.product_id)) {
          return recalc(i, i.qty + 1)
        }
        return i
      })
    })
  }

  const externalCodeFromStore = useNavigationStore((s) => s.externalScannedCode)
  const setExternalScannedCode = useNavigationStore((s) => s.setExternalScannedCode)

  const processIncomingCode = useCallback(async (codeToProcess: string) => {
    const clean = normalizeBarcode(codeToProcess)
    if (!clean) return
    try {
      const record = await barcodeService.lookupBarcode(clean)
      if (!record || !record.product) {
        setError(`Barcode "${clean}" not recognized in catalog`)
        return
      }
      const prod = record.product
      const varnt = record.variant
      const effectiveStock = varnt ? (Number(varnt.stock) || 0) : 999
      const price = varnt?.price ? Number(varnt.price) : Number(prod.price)

      const payload: ScannedItemPayload = {
        product_id: record.product_id,
        variant_id: record.variant_id || null,
        product_name: prod.name,
        name_ta: prod.name_ta,
        variant_name: varnt?.variant_name,
        price: price,
        offer_price: undefined,
        stock: effectiveStock,
        barcode: clean,
        image_url: prod.image_url,
        category: prod.category,
      }
      handleScannedItem(payload)
    } catch (err) {
      console.error('Failed to process incoming barcode:', err)
      setError('Failed to scan barcode')
    }
  }, [])

  useEffect(() => {
    const code = props.externalScannedCode || externalCodeFromStore
    if (code) {
      void processIncomingCode(code)
      setExternalScannedCode(null)
      props.onCodeProcessed?.()
    }
  }, [props.externalScannedCode, externalCodeFromStore, processIncomingCode, setExternalScannedCode, props])




  const removeItem = (id: string | number) => setItems(cur => cur.filter(i => i.id !== id))

  const updateItem = (id: string | number, field: 'name' | 'basePrice' | 'qty', value: string | number) => {
    setItems(cur => cur.map((item) => {
      if (item.id !== id) return item
      let safeVal = value
      if (field === 'basePrice') {
        safeVal = Math.max(0, Number(value) || 0)
      } else if (field === 'qty') {
        safeVal = Math.max(1, Number(value) || 1)
      }
      const nextItem = { ...item, [field]: safeVal } as PosItem
      return field === 'basePrice' || field === 'qty' ? recalc(nextItem, nextItem.qty) : nextItem
    }))
  }

  /** Adds an editable line for an item that is not in the catalogue. */
  const addCustomItem = () => {
    const custom = {
      id: `manual-${Date.now()}`,
      name: '',
      category: 'Unregistered',
      categoryId: null,
      remedy: [],
      price: 0,
      offerPrice: null,
      unitType: 'unit',
      unitLabel: 'pcs',
      baseQuantity: 1,
      stockQuantity: 999999,
      stockUnit: 'pcs',
      allowDecimalQuantity: false,
      predefinedOptions: [],
      isActive: true,
      sortOrder: 0,
      unit: 'pcs',
      rating: 0,
      stock: 999999,
      description: '',
      benefits: '',
    } as unknown as Product
    setItems(cur => [...cur, makePosItem(custom)])
  }

  const bumpQty = (id: string | number, delta: number) => {
    setItems(cur => {
      const ex = cur.find(i => i.id === id)
      if (!ex) return cur
      const next = ex.qty + delta
      if (next <= 0) return cur.filter(i => i.id !== id)
      return cur.map(i => i.id === id ? recalc(i, next) : i)
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const setQty = (id: string | number, val: number) => {
    if (val <= 0) { removeItem(id); return }
    setItems(cur => cur.map(i => i.id === id ? recalc(i, val) : i))
  }

  const handleOpenPriceEdit = (item: PosItem) => {
    setPriceEditModal({
      isOpen: true,
      item,
      newPrice: String(item.basePrice ?? 0),
      isSubmitting: false,
      error: '',
    })
  }

  const handleClosePriceEdit = () => {
    setPriceEditModal({
      isOpen: false,
      item: null,
      newPrice: '',
      isSubmitting: false,
      error: '',
    })
  }

  const handleSavePrice = async (updateInventory: boolean) => {
    const { item, newPrice } = priceEditModal
    if (!item) return

    const parsedPrice = parseFloat(newPrice)
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      setPriceEditModal(prev => ({ ...prev, error: 'Please enter a valid price (0 or greater).' }))
      return
    }

    if (updateInventory) {
      setPriceEditModal(prev => ({ ...prev, isSubmitting: true, error: '' }))
      try {
        if (!isDatabaseConfigured) {
          throw new Error('Database is not configured')
        }

        // 1. If item has a variant ID, update product_variants table
        if (item.variantId) {
          const { error: variantErr } = await db
            .from('product_variants')
            .update({ price: parsedPrice })
            .eq('id', item.variantId)
          if (variantErr) throw variantErr
        } else {
          // 2. Otherwise update standard products table
          const realDbId = toProductId(item.parentProductId || item.id)
          if (realDbId) {
            const { error: prodErr } = await db
              .from('products')
              .update({ price: parsedPrice })
              .eq('id', realDbId)
            if (prodErr) throw prodErr
          }
        }

        // Refresh product stores so catalog reflects new price
        void fetchProducts(true)
        void fetchVariants()
      } catch (err: unknown) {
        console.error('Failed to update price in inventory:', err)
        setPriceEditModal(prev => ({
          ...prev,
          isSubmitting: false,
          error: err instanceof Error ? err.message : 'Failed to update price in inventory'
        }))
        return
      }
    }

    // Update the item price in the active billing cart
    updateItem(item.id, 'basePrice', parsedPrice)
    handleClosePriceEdit()
  }

  const clearAll = () => {
    setItems([])
    setCustomer({ name: '', phone: '', address: '' })
    setInvoice(null)
    setBillPrintOpen(false)
    setBillPreviewOpen(false)
    setCashReceived('')
    setCouponInput('')
    setAppliedCoupon(null)
    setCouponError('')
    setManualDiscountValue('')
    setManualDiscountType('flat')
    setError('')
    setShipping('0')
    setRemarks('')
    setReferenceNumber('')
    setBirthDate('')
    setBillingDate('')
    setBillGstEnabled(false)
    setGstInput('')
    setGstType('percent')
    setSplitForm(emptySplitInput())
    setOrdermode('offline')
    setMobilePanelView('catalogue')
    searchRef.current?.focus()
  }

  const applyCoupon = async (overrideCode?: string) => {
    const code = (typeof overrideCode === 'string' ? overrideCode : couponInput).trim().toUpperCase()
    if (!code) { setCouponError('Enter a coupon code'); return }

    setCouponLoading(true)
    setCouponError('')
    setAppliedCoupon(null)

    try {
      if (!isDatabaseConfigured) {
        setCouponError('Coupon validation requires a live connection')
        return
      }

      const { data, error: dbErr } = await db
        .from('coupons')
        .select('*')
        .eq('is_active', true)
        .ilike('code', code)
        .single()

      if (dbErr || !data) {
        setCouponError('Invalid or expired coupon code')
        return
      }

      if (data.expiry_date && new Date(data.expiry_date) < new Date()) {
        setCouponError('This coupon has expired')
        return
      }

      if (data.usage_limit && data.usage_count >= data.usage_limit) {
        setCouponError('Coupon usage limit has been reached')
        return
      }

      if (data.min_order_value && subtotal < Number(data.min_order_value)) {
        setCouponError(`Minimum order of ${formatCurrency(Number(data.min_order_value))} required`)
        return
      }

      setAppliedCoupon({ code: String(data.code), percentage: Number(data.percentage), minOrderValue: Number(data.min_order_value || 0), discount: Number(data.discount || 0) })
    } catch {
      setCouponError('Failed to validate coupon. Try again.')
    } finally {
      setCouponLoading(false)
    }
  }

  const removeCoupon = () => {
    setAppliedCoupon(null)
    setCouponInput('')
    setCouponError('')
  }

  const getOrderType = (): 'pos_sale' | 'manual_sale' => (items.length > 0 && items.every((item) => item.source === 'manual') ? 'manual_sale' : 'pos_sale')

  const openDepositOrder = () => {
    if (!items.length) { setError('Add at least one product before creating a deposit order.'); return }
    if (!customer.name.trim()) { setError('Enter the customer name for the deposit order.'); return }
    if (!customer.phone.trim()) { setError('Enter the customer phone number for the deposit order.'); return }
    if (total <= 0) { setError('The order total must be greater than zero.'); return }
    const enteredAmount = Number(cashReceived) || 0
    const suggestedDeposit = enteredAmount > 0 && enteredAmount < total ? String(enteredAmount) : ''
    setDepositForm({ amount: suggestedDeposit, expectedDeliveryDate: '', paymentMethod: 'cash', address: customer.address || '', remarks, referenceNumber })
    setDepositSplit(emptySplitInput())
    setError('')
    setDepositOpen(true)
  }

  const saveDepositOrder = async (event: FormEvent) => {
    event.preventDefault()
    const depositAmount = Number(depositForm.amount)
    if (!Number.isFinite(depositAmount) || depositAmount <= 0 || depositAmount >= total) { setError(`Deposit must be greater than ${formatCurrency(0)} and less than ${formatCurrency(total)}.`); return }
    if (!depositForm.expectedDeliveryDate) { setError('Select the expected delivery date.'); return }
    if (depositForm.paymentMethod === 'split' && Math.abs(splitTotal(splitInputToDetails(depositSplit)) - depositAmount) >= 0.01) { setError(`Split amounts must add up to the deposit of ${formatCurrency(depositAmount)}.`); return }
    setSaving(true); setError('')
    try {
      const allocationBase = items.reduce((sum, item) => sum + item.lineTotal, 0)
      let allocated = 0
      const productsSnapshot = items.map((item, index) => {
        const lineTotal = index === items.length - 1
          ? Math.max(0, Math.round((subtotal - allocated) * 100) / 100)
          : Math.max(0, Math.round((allocationBase > 0 ? subtotal * item.lineTotal / allocationBase : subtotal / items.length) * 100) / 100)
        allocated += lineTotal
        return {
          product_id: item.parentProductId || toProductId(item.id), variant_id: item.variantId || null,
          variant_name: item.variantName || null, name: item.name, category: item.category,
          description: item.note || '', quantity: item.qty, unit: item.selectedUnit, unit_type: item.unitType,
          base_quantity: item.baseQuantity, base_price: Number(item.basePrice) || 0, line_total: lineTotal,
          source: 'advance_order', note: item.note || null,
        }
      })
      const created = await createAdvanceOrder({
        customerName: customer.name.trim(), phone: customer.phone.trim(), address: depositForm.address.trim(),
        productName: items.map(item => `${item.qty}× ${item.name}`).join(', '),
        category: Array.from(new Set(items.map(item => item.category).filter(Boolean))).join(', '),
        description: items.map(item => `${item.qty}× ${item.name}${item.note ? ` — ${item.note}` : ''}`).join('\n'),
        totalAmount: total, depositAmount, expectedDeliveryDate: depositForm.expectedDeliveryDate,
        remarks: depositForm.remarks, referenceNumber: depositForm.referenceNumber, paymentMethod: depositForm.paymentMethod, createdByName: role || 'Staff',
        products: productsSnapshot,
        // total = subtotal - discount + GST + delivery; keep the parts so receipts / invoice can show them
        breakdown: {
          subtotal: Math.round(subtotal * 100) / 100,
          deliveryCharge: Math.max(0, Number(shipping || 0) || 0),
          discount: Math.round((subtotal - discountedSubtotal) * 100) / 100,
          gstRate: totalGst > 0 ? (gstType === 'percent' ? Math.max(0, Number(gstInput) || 0) : Math.round((totalGst / Math.max(discountedSubtotal, 0.01)) * 10000) / 100) : 0,
          cgst: Math.round((totalGst / 2) * 100) / 100,
          sgst: Math.round((totalGst - Math.round((totalGst / 2) * 100) / 100) * 100) / 100,
        },
        splitDetails: depositForm.paymentMethod === 'split' ? splitInputToDetails(depositSplit) : undefined,
      })
      setDepositCreated(created)
      setDepositOpen(false)
      clearAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deposit order')
    } finally {
      setSaving(false)
    }
  }

  // ── Generate bill ─────────────────────────────────────────────────────
  const generateBill = async () => {
    if (!items.length) { setError('Add at least one product.'); return }
    // Validate required phone
    const normalizedPhone = normalizePhone(customer.phone || '')
    if (!normalizedPhone) { setError('Please enter a valid Indian mobile number (e.g. 9876543210 or +91 9876543210)'); return }
    // Validate payment amount (only required for cash)
    if (ordermode !== 'online' && paymentType === 'cash' && !cashReceived.trim()) { setError('Enter the amount received from customer'); return }
    if (ordermode !== 'online' && paymentType === 'cash' && cashReceivedNum < total) { setError(`Insufficient payment. Customer still owes ${formatCurrency(total - cashReceivedNum)}`); return }
    if (ordermode !== 'online' && paymentType === 'split') {
      const enteredSplit = splitTotal(splitInputToDetails(splitForm))
      if (enteredSplit < total - 0.009) { setError(`Split amounts must cover ${formatCurrency(total)}. Customer still owes ${formatCurrency(total - enteredSplit)}.`); return }
      if (enteredSplit - total > splitInputToDetails(splitForm).cash + 0.009) { setError('Change can only be returned from cash. Lower the QR / GPay or card amount.'); return }
    }
    // Validate online mode availability
    if (ordermode === 'online' && !isDatabaseConfigured) { setError('Cannot place online orders while offline'); return }
    setSaving(true); setError('')
    try {
      const paymentMode = ordermode === 'online' ? 'online' : paymentType
      // Split bills keep only what was actually collected: any change goes back out of the cash part
      const splitEntered = splitInputToDetails(splitForm)
      const splitChange = Math.max(0, Math.round((splitTotal(splitEntered) - total) * 100) / 100)
      const splitDetailsForBill = ordermode !== 'online' && paymentType === 'split'
        ? { ...splitEntered, cash: Math.round((splitEntered.cash - splitChange) * 100) / 100 }
        : {}
      // Determine the effective billing date/time
      const effectiveBillingDate = billingDate.trim()
        ? new Date(billingDate).toISOString()
        : new Date().toISOString()

      const created = await createOrderWithStock({
        customerName: customer.name.trim() || 'Walk-in Customer',
        phone: normalizedPhone,
        address: customer.address.trim() || 'POS Counter',
        items: items.map(item => buildStructuredOrderItem({
          productId:    item.parentProductId ? item.parentProductId : toProductId(item.id),
          variantId:    item.variantId   ?? null,
          variantName:  item.variantName ?? null,
          name: item.name,
          tamilName: item.tamilName || item.nameTa || null,
          quantity: item.qty,
          unit: item.selectedUnit,
          unitType: item.unitType,
          baseQuantity: item.baseQuantity,
          basePrice: Number(item.basePrice) || 0,
          mrp: offerMrp(item),
          imageUrl: item.imageUrl || item.image || null,
          source: item.source || 'catalogue',
          isManual: item.source === 'manual' || item.category === 'Unregistered',
          category: item.category || null,
          note: item.note || null,
        })),
        shipping: Number(shipping || 0),
        status: 'completed',
        orderMode: ordermode,
        orderType: getOrderType(),
        deliveryCharge: Number(shipping || 0),
        discountAmount: couponDiscount,
        manualDiscountAmount,
        manualDiscountType,
        manualDiscountValue: manualDiscountNumeric,
        couponCode: appliedCoupon?.code,
        couponPercentage: appliedCoupon?.percentage,
        totalGst,
        gstEnabled: billGstEnabled,
        paymentMethod: paymentMode,
        splitDetails: splitDetailsForBill,
        remarks: remarks.trim(),
        referenceNumber: referenceNumber.trim(),
        billingDate: effectiveBillingDate,
      })

      // ── CRITICAL: immediately fix totals in DB, independent of PDF upload ──
      // The RPC may store an incorrect total if items JSONB parsing differs.
      // This guarantees the correct client-computed values are always saved.
      const { error: updateErr } = await db.from('orders').update({
        subtotal,
        total,
        total_gst: totalGst,
        gst_amount: totalGst,
        payment_mode: paymentMode,
        payment_method: paymentMode,
        split_details: splitDetailsForBill,
        discount_amount: couponDiscount,
        coupon_code: appliedCoupon?.code || null,
        coupon_percentage: appliedCoupon?.percentage || 0,
        manual_discount_amount: manualDiscountAmount,
        delivery_charge: Number(shipping || 0),
        remarks: remarks.trim(),
        reference_number: referenceNumber.trim() || null,
        billing_date: effectiveBillingDate,
      }).eq('id', created.orderId)

      if (updateErr) {
        console.warn('Post-order update warning:', updateErr)
      }

      // Explicit verification: confirm the order record actually exists in the database
      // before transitioning to the completed bill state or allowing WhatsApp link send
      const { data: verifiedOrder, error: verifyErr } = await db
        .from('orders')
        .select('id, invoice_no')
        .eq('id', created.orderId)
        .maybeSingle()

      if (verifyErr || !verifiedOrder) {
        throw new Error(`Invoice confirmation failed: could not verify order #${created.invoiceNo} was saved in the database.`)
      }
      if (birthDate && normalizedPhone) {
        void birthdayService.save({ name: customer.name, phone: normalizedPhone, birthDate })
      }
      const createdInvoice: InvoiceSnap = {
        id: created.orderId,
        invoiceNo: created.invoiceNo,
        orderType: getOrderType(),
        date: billingDate.trim() ? new Date(billingDate).toISOString() : created.createdAt,
        items: [...items],
        subtotal,
        shipping: Number(shipping || 0),
        couponCode: appliedCoupon?.code,
        couponDiscount,
        manualDiscountAmount,
        manualDiscountType,
        manualDiscountValue: manualDiscountNumeric,
        gstAmount: totalGst,
        total,
        customerName: customer.name.trim() || 'Walk-in Customer',
        phone: normalizedPhone,
        address: customer.address.trim() || 'POS Counter',
        amountReceived: paymentType === 'split' ? splitTotal(splitEntered) : cashReceivedNum,
        balanceReturned: paymentType === 'split' ? splitChange : balanceToReturn,
        paymentMode: ordermode === 'online' ? 'Online' : paymentType === 'split' ? formatPaymentLabel('split', splitDetailsForBill) : paymentType === 'qr' ? 'QR' : paymentType === 'card' ? 'Card' : 'Cash',
        paymentMethod: paymentMode,
      }
      setInvoice(createdInvoice)
      setItems([])
      setCustomer({ name: '', phone: '', address: '' })
      void fetchProducts()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to generate bill')
    } finally {
      setSaving(false)
    }
  }

  const cashReceivedNum = Number(cashReceived) || 0
  const balanceToReturn = cashReceivedNum > 0 && cashReceivedNum >= total ? cashReceivedNum - total : 0
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const isInsufficientPayment = cashReceived !== '' && cashReceivedNum > 0 && cashReceivedNum < total
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const change = cashReceived && Number(cashReceived) >= total
    ? Number(cashReceived) - total : null

  const sendPosWhatsApp = (inv: InvoiceSnap) => {
    const invoiceUrl = publicInvoiceUrl(inv.invoiceNo)
    const message = buildProfessionalWhatsAppMessage({
      customerName: inv.customerName,
      phone: inv.phone,
      invoiceNumber: inv.invoiceNo,
      invoiceUrl,
      paymentMode: inv.paymentMode || 'POS',
      items: inv.items.map((item) => ({
        name: item.name,
        qty: item.qty,
        unit: item.selectedUnit,
        unitType: item.unitType,
        rate: Number(item.basePrice) || 0,
        lineTotal: item.lineTotal,
      })),
      subtotal: inv.subtotal,
      couponDiscount: inv.couponDiscount,
      manualDiscountAmount: inv.manualDiscountAmount,
      shipping: inv.shipping,
      gstAmount: inv.gstAmount,
      total: inv.total,
    })
    window.open(toWhatsAppUrl(inv.phone || customer.phone || '', message), '_blank', 'noopener,noreferrer')
  }

  const persistInvoicePdf = async (inv: InvoiceSnap) => {
    try {
      const file = invoicePdfRef.current
        ? await invoicePdfFileFromElement(invoicePdfRef.current, inv.invoiceNo)
        : await invoicePdfFromProps(invoicePropsFor(inv))
      // Upload PDF and save its URL — total fields already saved immediately after RPC
      const url = await uploadInvoicePdf(file, inv.invoiceNo)
      await db.from('orders').update({ invoice_pdf_url: url }).eq('id', inv.id)
      setInvoice(current => current?.id === inv.id ? { ...current, invoicePdfUrl: url } : current)
    } catch (err) {
      console.warn('Invoice PDF could not be stored:', err)
    }
  }

  /** Same bill data for the A4 / A5 invoice, the thermal receipt and the preview. */
  const invoicePropsFor = (inv: InvoiceSnap): InvoiceProps => ({
    invoiceNo: inv.invoiceNo,
    date: inv.date,
    customerName: inv.customerName,
    phone: inv.phone,
    address: inv.address,
    items: inv.items.map(item => ({
      id: String(item.id),
      name: item.name,
      nameTa: item.nameTa,
      qty: item.qty,
      quantity: item.qty,
      unit: item.selectedUnit,
      unit_type: item.unitType,
      base_quantity: item.baseQuantity,
      base_price: Number(item.basePrice) || 0,
      line_total: item.lineTotal,
      price: item.price,
      offerPrice: item.offerPrice ?? undefined,
      hsn: item.hsnCode || products.find(pr => String(pr.id) === String(item.parentProductId || item.id))?.hsnCode || undefined,
    })),
    subtotal: inv.subtotal,
    shipping: inv.shipping,
    total: inv.total,
    status: 'completed',
    discountAmount: inv.couponDiscount || 0,
    manualDiscountAmount: inv.manualDiscountAmount || 0,
    gstAmount: inv.gstAmount || 0,
    couponCode: inv.couponCode,
    paymentMode: inv.paymentMode,
    channel: inv.orderType === 'online_request' ? 'online' : 'offline',
    amountReceived: inv.amountReceived,
  })

  // Save the PDF copy of each new bill once its invoice has rendered
  useEffect(() => {
    if (!invoice || invoice.invoicePdfUrl || pdfSavedFor.current === invoice.id) return
    pdfSavedFor.current = invoice.id
    const inv = invoice
    setTimeout(() => { void persistInvoicePdf(inv) }, 400)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice])

  // ══ INVOICE SCREEN ════════════════════════════════════════════════════
  if (invoice) {
    const billProps = invoicePropsFor(invoice)
    const isGstBill = (invoice.gstAmount || 0) > 0
    const modeChip = /^split/i.test(invoice.paymentMode || '') ? 'Split' : invoice.paymentMode === 'QR' ? 'QR / GPay' : (invoice.paymentMode || 'Cash')
    const actionBtn = 'inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-3 text-[11px] font-black uppercase tracking-wider text-[#111111] transition-colors hover:bg-gray-50'

    return (
      <div className="mobile-page-shell print:hidden">
        <div className="mx-auto w-full max-w-[680px] px-0 py-4 sm:py-6">
          <div className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm sm:p-8">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 pb-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-[26px] font-black tracking-tight text-[#111111] sm:text-[28px]">{l('Bill Generated', 'பில் உருவாக்கப்பட்டது')}</h1>
                  <span className="rounded-md bg-gray-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-[#111111]">{isGstBill ? 'GST' : 'Non-GST'}</span>
                </div>
                <p className="mt-1 font-mono text-xs font-bold text-primary">#{formatInvoiceNo(invoice.invoiceNo)}</p>
              </div>
              <button onClick={clearAll} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-[#111111] px-4 text-[11px] font-black uppercase tracking-wider text-white hover:bg-black">
                <Plus size={16} /> New Sale
              </button>
            </div>

            {/* Payment receipt */}
            <div className="mt-4 rounded-2xl border border-gray-200 p-5">
              <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-gray-400">{l('Payment Receipt', 'கட்டண ரசீது')}</p>
                <span className="rounded-md bg-gray-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-primary">{modeChip}</span>
              </div>
              <div className="flex items-center justify-between pt-4">
                <span className="text-sm font-semibold text-gray-600">{l('Grand Total', 'மொத்த தொகை')}</span>
                <span className="text-2xl font-black tabular-nums text-[#111111]">{formatCurrency(invoice.total)}</span>
              </div>
              <div className="flex items-center justify-between pt-3">
                <span className="text-sm font-semibold text-gray-600">{l('Amount Received', 'பெற்ற தொகை')}</span>
                <span className="text-lg font-black tabular-nums text-[#111111]">{formatCurrency(invoice.amountReceived || invoice.total)}</span>
              </div>
              <div className="mt-4 flex items-center justify-between rounded-xl border border-gray-200 bg-gray-100 px-4 py-4">
                <span className="text-sm font-black text-primary">{l('Balance Returned', 'திரும்பிய பணம்')}</span>
                <span className="text-2xl font-black tabular-nums text-primary">{formatCurrency(invoice.balanceReturned || 0)}</span>
              </div>
              {/^split/i.test(invoice.paymentMode || '') && (
                <p className="mt-3 text-xs font-semibold text-gray-500">{invoice.paymentMode}</p>
              )}
            </div>

            {/* Bill breakdown */}
            {(() => {
              const gst = invoice.gstAmount || 0
              const cgst = Math.round((gst / 2) * 100) / 100
              const sgst = Math.round((gst - cgst) * 100) / 100
              const taxable = Math.max(0, invoice.subtotal - (invoice.couponDiscount || 0) - (invoice.manualDiscountAmount || 0))
              const rows: Array<[string, string, string?]> = [
                [l('Subtotal', 'துணை மொத்தம்'), formatCurrency(invoice.subtotal)],
                ...(invoice.couponDiscount > 0 ? [[`Coupon${invoice.couponCode ? ` (${invoice.couponCode})` : ''}`, `−${formatCurrency(invoice.couponDiscount)}`, 'text-emerald-600'] as [string, string, string]] : []),
                ...(invoice.manualDiscountAmount > 0 ? [['Discount', `−${formatCurrency(invoice.manualDiscountAmount)}`, 'text-emerald-600'] as [string, string, string]] : []),
                ...(invoice.shipping > 0 ? [['Delivery', formatCurrency(invoice.shipping)] as [string, string]] : []),
                ...(gst > 0 ? [[`CGST${gstPctLabel(cgst, taxable)}`, formatCurrency(cgst)], [`SGST${gstPctLabel(sgst, taxable)}`, formatCurrency(sgst)], [`Total GST${gstPctLabel(gst, taxable)}`, formatCurrency(gst)]] as Array<[string, string]> : []),
              ]
              return (
                <div className="mt-4 rounded-2xl border border-gray-200 p-5">
                  <p className="border-b border-gray-100 pb-3 text-[11px] font-black uppercase tracking-[0.14em] text-gray-400">{l('Bill Summary', 'பில் சுருக்கம்')}</p>
                  <div className="space-y-2.5 pt-3 text-sm">
                    {rows.map(([k, v, tone]) => (
                      <div key={k} className="flex items-center justify-between">
                        <span className="font-semibold text-gray-600">{k}</span>
                        <span className={`font-bold tabular-nums ${tone || 'text-[#111111]'}`}>{v}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between border-t border-gray-100 pt-3">
                      <span className="font-black text-[#111111]">{l('Grand Total', 'மொத்த தொகை')}</span>
                      <span className="text-lg font-black tabular-nums text-[#111111]">{formatCurrency(invoice.total)}</span>
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* Actions */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <button type="button" onClick={() => setBillPrintOpen(true)} className={actionBtn}>
                <Printer size={16} /> {l('Print Receipt', 'ரசீது அச்சிடு')}
              </button>
              <button type="button" onClick={() => setBillPreviewOpen(true)} className={actionBtn}>
                <Eye size={16} /> {l('View', 'பார்')}
              </button>
              <button type="button" onClick={() => sendPosWhatsApp(invoice)} className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-3 text-[11px] font-black uppercase tracking-wider text-white hover:bg-emerald-600">
                <MessageCircle size={16} /> WhatsApp Invoice
              </button>
              <button type="button" onClick={clearAll} className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-[#111111] px-3 text-[11px] font-black uppercase tracking-wider text-white hover:bg-black">
                <Plus size={16} /> New Sale
              </button>
            </div>

            {/* Items sold */}
            <div className="mt-4 rounded-2xl border border-gray-200 p-5">
              <p className="border-b border-gray-100 pb-3 text-[11px] font-black uppercase tracking-[0.14em] text-gray-400">{l('Items Sold', 'விற்ற பொருட்கள்')}</p>
              <div className="space-y-2.5 pt-3">
                {invoice.items.map(item => (
                  <div key={item.id} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 font-semibold text-[#111111]">
                      {item.name}{' '}
                      <span className="text-[11px] font-semibold text-gray-400">× {formatQuantityDisplay(item.qty, item.selectedUnit, item.unitType)}</span>
                    </span>
                    <span className="shrink-0 font-bold tabular-nums">{formatCurrency(item.lineTotal)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <PrintSettingsModal open={billPrintOpen} onClose={() => setBillPrintOpen(false)} onPrint={(settings) => printBill(billProps, settings)} />
        {billPreviewOpen && (
          <InvoicePreviewModal
            invoice={billProps}
            fullPageUrl={publicInvoiceUrl(invoice.invoiceNo)}
            onClose={() => setBillPreviewOpen(false)}
          />
        )}

        {/* Off-screen copy of the invoice used to save the PDF that WhatsApp links to */}
        <div aria-hidden="true" style={{ position: 'fixed', left: -10000, top: 0, width: 760, pointerEvents: 'none' }}>
          <div ref={invoicePdfRef}>
            <Invoice {...billProps} />
          </div>
        </div>
      </div>
    )
  }

  // ══ MAIN POS SCREEN ══════════════════════════════════════════════════
  return (
    <div data-embedded={embeddedMode} className={`flex flex-col bg-white print:hidden overflow-x-hidden ${embeddedMode ? '' : 'h-full overflow-y-auto hide-scrollbar'}`} style={embeddedMode ? undefined : { WebkitOverflowScrolling: 'touch' }}>
      {/* Header */}
      <div className={`shrink-0 flex flex-col gap-4 pb-6 mb-6 border-b border-gray-200 sm:flex-row sm:items-center sm:justify-between ${embeddedMode ? '' : 'px-4 pt-5 md:px-8'}`}>
        <div className="flex items-stretch gap-4 min-w-0">
          <span className="w-[6px] shrink-0 rounded-full bg-primary" aria-hidden />
          <div className="min-w-0">
            <h2 className="text-xl font-black leading-tight tracking-tight text-[#111111]">POS Billing Panel</h2>
            <p className="text-[11px] font-semibold text-[#111111]">Quick Invoice generator &amp; database synced checkout</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Offline (POS) / Online order */}
          <div className="inline-flex items-center rounded-full border border-gray-200 bg-white p-1.5 shadow-[0_2px_10px_rgba(0,0,0,0.05)]" role="tablist" aria-label="Order source">
            <button
              type="button"
              role="tab"
              aria-selected={ordermode === 'offline'}
              onClick={() => setOrdermode('offline')}
              className={`h-10 rounded-full px-6 text-[10px] font-bold uppercase tracking-wider transition-colors ${ordermode === 'offline' ? 'bg-primary text-primary-ink shadow' : 'text-[#111111] hover:bg-gray-50'}`}
            >
              Offline (POS)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={ordermode === 'online'}
              onClick={() => setOrdermode('online')}
              className={`inline-flex h-10 items-center gap-2 rounded-full px-6 text-[10px] font-bold uppercase tracking-wider transition-colors ${ordermode === 'online' ? 'bg-primary text-primary-ink shadow' : 'text-[#111111] hover:bg-gray-50'}`}
            >
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              Online Order
            </button>
          </div>
          {!embeddedMode && (
            <>
              <button
                onClick={() => navigate('/dashboard')}
                className="h-9 rounded-full bg-primary px-4 text-[10px] font-bold uppercase tracking-wider text-primary-ink hover:bg-primary-hover cursor-pointer"
              >
                Dashboard
              </button>
              <button
                onClick={() => { logout(); navigate('/admin-login', { replace: true }) }}
                title="Logout"
                className="flex h-9 w-11 items-center justify-center rounded-full border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 cursor-pointer"
              >
                <Power size={16} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main Content Split */}
      <div className={`grid grid-cols-1 xl:grid-cols-[minmax(0,1.75fr)_minmax(340px,1fr)] gap-6 xl:gap-10 pb-6 items-start ${embeddedMode ? '' : 'px-4 md:px-8'}`} style={{ touchAction: 'pan-y' }}>

        {/* LEFT COLUMN */}
        <div className="flex flex-col gap-6 min-w-0">

          {/* Customer Details Card */}
          <section className="rounded-xl border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
            <h3 className="mb-6 flex items-center gap-3 text-base font-black tracking-tight text-[#111111]">
              <User size={20} strokeWidth={1.75} />
              Customer Details
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-x-7 gap-y-5">
              <div className="min-w-0">
                <label htmlFor="pos-customer-name" className={posLabel}>Customer Name</label>
                <input
                  id="pos-customer-name"
                  name="customerName"
                  autoComplete="name"
                  type="text"
                  value={customer.name}
                  onChange={e => setCustomer({ ...customer, name: e.target.value })}
                  placeholder="Walk-in Customer"
                  className={posInput}
                />
              </div>
              <div className="min-w-0">
                <label htmlFor="pos-customer-phone" className={posLabel}>Mobile Number (WhatsApp)</label>
                <input
                  id="pos-customer-phone"
                  name="customerPhone"
                  autoComplete="tel"
                  type="text"
                  inputMode="tel"
                  value={customer.phone}
                  onChange={e => setCustomer({ ...customer, phone: e.target.value })}
                  placeholder="Enter 10-digit number"
                  className={`${posInput} ${customer.phone && !normalizePhone(customer.phone) ? '!border-red-400 !bg-red-50' : ''}`}
                />
              </div>
              <div className="min-w-0">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <label htmlFor="pos-billing-date" className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#111111]">
                    <CalendarDays size={15} strokeWidth={1.75} /> Bill Date
                  </label>
                  {billingDate ? (
                    <button type="button" onClick={() => setBillingDate('')} className="text-[10.5px] font-black uppercase tracking-[0.14em] text-[#DC2626] hover:underline">
                      Reset to now
                    </button>
                  ) : (
                    <span className="text-[10.5px] font-black uppercase tracking-[0.14em] text-primary">Custom / Past</span>
                  )}
                </div>
                <input
                  id="pos-billing-date"
                  type="datetime-local"
                  value={billingDate}
                  onChange={e => setBillingDate(e.target.value)}
                  className={`${posInput} !font-black`}
                />
              </div>
              <div className="min-w-0 md:col-span-3">
                <label htmlFor="pos-customer-address" className={posLabel}>Customer Address (Optional)</label>
                <input
                  id="pos-customer-address"
                  name="customerAddress"
                  autoComplete="street-address"
                  type="text"
                  value={customer.address}
                  onChange={e => setCustomer({ ...customer, address: e.target.value })}
                  placeholder="Enter full address"
                  className={posInput}
                />
              </div>
              <div className="min-w-0">
                <label htmlFor="pos-birth-date" className={posLabel}>Birthday (Optional)</label>
                <input
                  id="pos-birth-date"
                  name="birthDate"
                  type="date"
                  max={new Date().toISOString().slice(0, 10)}
                  value={birthDate}
                  onChange={e => setBirthDate(e.target.value)}
                  className={posInput}
                />
              </div>
              <div className="min-w-0">
                <label htmlFor="pos-reference-number" className={posLabel}>Reference Number (Internal)</label>
                <input
                  id="pos-reference-number"
                  name="referenceNumber"
                  type="text"
                  value={referenceNumber}
                  onChange={e => setReferenceNumber(e.target.value)}
                  placeholder="e.g. REF-1002"
                  maxLength={60}
                  className={posInput}
                />
              </div>
              <div className="min-w-0 md:col-span-3">
                <label htmlFor="pos-remarks" className={posLabel}>Remarks (Internal)</label>
                <textarea
                  id="pos-remarks"
                  name="remarks"
                  rows={2}
                  value={remarks}
                  onChange={e => setRemarks(e.target.value)}
                  placeholder="Shop notes only. Not printed on the bill or sent to the customer"
                  maxLength={500}
                  className={`${posInput} resize-y`}
                />
              </div>
            </div>
          </section>

          {/* Order Items Card */}
          <section className="flex min-h-[420px] flex-col rounded-xl border border-gray-200 bg-white p-4 sm:p-6 shadow-sm">
            <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <h3 className="flex items-center gap-3 text-base font-black tracking-tight text-[#111111]">
                <Receipt size={20} strokeWidth={1.75} />
                Order Items{items.length > 0 ? ` (${items.length})` : ''}
              </h3>
              <div className="flex flex-wrap justify-end gap-2.5">
                <button type="button" onClick={clearAll} disabled={items.length === 0} className={posToolBtn}>
                  <Trash2 size={16} strokeWidth={1.75} /> Clear Order
                </button>
                <button type="button" onClick={() => setAddToCatalogOpen(true)} className={posToolBtn}>
                  <PackagePlus size={16} strokeWidth={1.75} /> Add to Catalog
                </button>
                <button type="button" onClick={addCustomItem} className={`${posToolBtn} !bg-gray-50`}>
                  <Plus size={16} strokeWidth={1.75} /> Add Custom Item
                </button>
              </div>
            </div>

            {/* Barcode scanner */}
            <div className="mb-4">
              <BarcodeScannerInput onItemScanned={handleScannedItem} />
            </div>

            {/* Table Header */}
            <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_130px_44px] gap-4 border-b border-gray-200 px-2.5 pb-3 pt-2">
              <span className="text-[11px] font-black uppercase tracking-[0.18em] text-[#111111]">Item Name / Description</span>
              <span className="text-center text-[11px] font-black uppercase tracking-[0.18em] text-[#111111]">Price (₹)</span>
              <span className="text-center text-[11px] font-black uppercase tracking-[0.18em] text-[#111111]">Qty</span>
              <span />
            </div>

            {/* Table Body */}
            <div className="flex-1 space-y-3 pt-4">
              {items.length === 0 && (
                <div className="flex flex-col gap-3">
                  <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_130px_44px] items-center gap-4">
                    <div className="flex gap-2.5">
                      <button type="button" onClick={addCustomItem} className="h-9 flex-1 rounded-xl border border-gray-200 px-4 text-left text-[14px] font-medium text-gray-500 hover:border-gray-300">
                        Item name
                      </button>
                      <button type="button" onClick={() => setCatalogOpen(true)} className="inline-flex h-9 items-center gap-2 rounded-xl border border-gray-300 bg-gray-50 px-4 text-[10px] font-bold uppercase tracking-wider text-[#111111] hover:bg-gray-100">
                        <List size={16} strokeWidth={1.75} /> Catalog
                      </button>
                    </div>
                    <div className="flex h-9 items-center justify-center rounded-xl border border-gray-200 text-[14px] font-medium text-gray-400">0</div>
                    <div className="flex h-9 items-center justify-between rounded-xl border border-gray-200 px-3 text-[14px] font-black text-gray-300"><span>−</span><span className="text-[#111111]">1</span><span>+</span></div>
                    <span className="flex h-9 w-11 items-center justify-center rounded-xl border border-gray-200 text-gray-300"><Trash2 size={17} strokeWidth={1.75} /></span>
                  </div>
                  <div className="md:hidden flex gap-2">
                    <button type="button" onClick={addCustomItem} className="h-9 flex-1 rounded-xl border border-gray-200 px-4 text-left text-[14px] font-medium text-gray-500">Item name</button>
                    <button type="button" onClick={() => setCatalogOpen(true)} className="inline-flex h-9 items-center gap-2 rounded-xl border border-gray-300 bg-gray-50 px-4 text-[10px] font-bold uppercase text-[#111111]"><List size={16} /> Catalog</button>
                  </div>
                </div>
              )}

              {items.map(item => (
                <div key={item.id}>
                  {/* Mobile row */}
                  <div className="md:hidden space-y-3 rounded-2xl border border-gray-200 p-3.5">
                    <div className="flex items-start gap-2.5">
                      <div className="min-w-0 flex-1">
                        {item.source === 'manual' ? (
                          <input
                            type="text"
                            value={item.name}
                            onChange={e => updateItem(item.id, 'name', e.target.value)}
                            placeholder="Item name"
                            className={posInput}
                          />
                        ) : (
                          <p className="text-sm font-black text-[#111111] break-words">{itemDisplayName(item)}<OfferLine item={item} /></p>
                        )}
                      </div>
                      <button type="button" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name || 'item'}`} className="flex h-9 w-11 shrink-0 items-center justify-center rounded-xl border border-gray-200 text-[#111111] hover:bg-red-50 hover:text-red-600">
                        <Trash2 size={17} strokeWidth={1.75} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      {item.source === 'manual' ? (
                        <input type="number" inputMode="decimal" onWheel={(e) => (e.target as HTMLInputElement).blur()} value={item.basePrice || ''} onChange={e => updateItem(item.id, 'basePrice', e.target.value)} placeholder="0" className={`${posInput} !w-28 text-center`} aria-label="Price" />
                      ) : (
                        <button type="button" onClick={() => handleOpenPriceEdit(item)} className="h-9 rounded-xl border border-gray-200 px-4 text-[14px] font-black text-[#111111]">
                          ₹{Number(item.basePrice || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </button>
                      )}
                      <div className="flex h-9 items-center gap-1 rounded-xl border border-gray-200 px-1.5">
                        <button type="button" onClick={() => bumpQty(item.id, -1)} className="h-8 w-8 rounded-lg text-[18px] font-bold text-[#111111] hover:bg-gray-100" aria-label="Decrease quantity">−</button>
                        <span className="w-8 text-center text-sm font-black text-[#111111]">{item.qty}</span>
                        <button type="button" onClick={() => bumpQty(item.id, 1)} className="h-8 w-8 rounded-lg text-[18px] font-bold text-[#111111] hover:bg-gray-100" aria-label="Increase quantity">+</button>
                      </div>
                      <span className="text-sm font-black text-[#111111]">{formatCurrency(item.lineTotal)}</span>
                    </div>
                  </div>

                  {/* Desktop row */}
                  <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_130px_44px] items-center gap-4">
                    <div className="flex min-w-0 gap-2.5">
                      {item.source === 'manual' ? (
                        <input
                          type="text"
                          value={item.name}
                          onChange={e => updateItem(item.id, 'name', e.target.value)}
                          placeholder="Item name"
                          className={`${posInput} flex-1`}
                          autoFocus={!item.name}
                        />
                      ) : (
                        <div className="flex h-9 min-w-0 flex-1 items-center rounded-xl border border-gray-200 px-4">
                          <span className="truncate text-[14px] font-bold text-[#111111]">{itemDisplayName(item)}</span>
                          <OfferLine item={item} />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setCatalogOpen(true)}
                        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-gray-300 bg-gray-50 px-4 text-[10px] font-bold uppercase tracking-wider text-[#111111] hover:bg-gray-100"
                        title="Pick from catalog"
                      >
                        <List size={16} strokeWidth={1.75} /> Catalog
                      </button>
                    </div>
                    {item.source === 'manual' ? (
                      <input
                        type="number"
                        inputMode="decimal"
                        onWheel={(e) => (e.target as HTMLInputElement).blur()}
                        value={item.basePrice || ''}
                        onChange={e => updateItem(item.id, 'basePrice', e.target.value)}
                        placeholder="0"
                        aria-label="Price"
                        className={`${posInput} text-center`}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleOpenPriceEdit(item)}
                        title="Click to edit price"
                        className="h-9 rounded-xl border border-gray-200 text-center text-[14px] font-black text-[#111111] hover:border-gray-300"
                      >
                        {Number(item.basePrice || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </button>
                    )}
                    <div className="flex h-9 items-center justify-between rounded-xl border border-gray-200 px-2">
                      <button type="button" onClick={() => bumpQty(item.id, -1)} className="h-8 w-8 rounded-lg text-[16px] font-bold text-[#111111] hover:bg-gray-100" aria-label="Decrease quantity">−</button>
                      <span className="text-sm font-black text-[#111111]">{item.qty}</span>
                      <button type="button" onClick={() => bumpQty(item.id, 1)} className="h-8 w-8 rounded-lg text-[16px] font-bold text-[#111111] hover:bg-gray-100" aria-label="Increase quantity">+</button>
                    </div>
                    <button type="button" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name || 'item'}`} className="flex h-9 w-11 items-center justify-center rounded-xl border border-gray-200 text-[#111111] hover:bg-red-50 hover:text-red-600 hover:border-red-200">
                      <Trash2 size={17} strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN — Current Order */}
        <aside className="xl:sticky xl:top-4 rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-gray-200 p-4 sm:p-6">
            <h3 className="flex items-center gap-3 text-base font-black tracking-tight text-[#111111]">
              <ShoppingBag size={20} strokeWidth={1.75} />
              Current Order
            </h3>
            <span className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3.5 py-1.5 text-[10.5px] font-black uppercase tracking-wider text-[#111111]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#111111]" />
              {ordermode === 'online' ? 'Online Order' : 'Offline (POS)'}
            </span>
          </div>

          <div className="space-y-6 p-4 sm:p-6">
            {/* Summary */}
            <div className="rounded-xl border border-gray-200 px-4 py-3.5">
              <dl className="space-y-3.5 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="uppercase text-[#111111]">Source</dt>
                  <dd className="rounded-md border border-[#111111] px-2.5 py-0.5 text-[10.5px] font-black uppercase tracking-[0.16em] text-[#111111]">{ordermode}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="uppercase text-[#111111]">Customer</dt>
                  <dd className="truncate font-bold text-[#111111]">{customer.name.trim() || '-'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="uppercase text-[#111111]">Phone</dt>
                  <dd className="font-bold text-[#111111]">{customer.phone.trim() || '-'}</dd>
                </div>
              </dl>
              <div className="mt-4 border-t border-gray-200 pt-4">
                {items.length === 0 ? (
                  <p className="py-3 text-center text-[13px] italic text-[#111111]">No items added yet</p>
                ) : (
                  <ul className="max-h-[160px] space-y-1.5 overflow-y-auto">
                    {items.map(item => (
                      <li key={item.id} className="flex justify-between gap-3 text-[13px] text-[#111111]">
                        <span className="truncate">{item.qty}× {itemDisplayName(item) || 'Custom item'}</span>
                        <span className="font-black">{formatCurrency(item.lineTotal)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Coupon Code */}
            <div>
              <label htmlFor="pos-coupon-input" className={posSideLabel}>Coupon Code</label>
              <div className="flex gap-2.5">
                <input
                  id="pos-coupon-input"
                  name="posCouponCode"
                  autoComplete="off"
                  type="text"
                  value={couponInput}
                  onChange={e => {
                    const val = e.target.value.toUpperCase()
                    setCouponInput(val)
                    if (availableCoupons.some(c => c.code.toUpperCase() === val)) {
                      void applyCoupon(val)
                    }
                  }}
                  placeholder="Enter code"
                  disabled={appliedCoupon !== null}
                  list="pos-coupons"
                  className={`${posInput} uppercase disabled:bg-gray-100`}
                />
                <datalist id="pos-coupons">
                  {availableCoupons.map(c => <option key={c.code} value={c.code} />)}
                </datalist>
                {appliedCoupon ? (
                  <button type="button" onClick={removeCoupon} className="h-9 shrink-0 rounded-xl bg-red-50 px-4 text-[10px] font-bold uppercase text-red-600 hover:bg-red-100">Remove</button>
                ) : (
                  <button type="button" onClick={() => void applyCoupon()} disabled={couponLoading || !couponInput.trim()} className="h-9 shrink-0 rounded-xl bg-primary px-5 text-[10px] font-bold uppercase text-primary-ink hover:bg-primary-hover disabled:opacity-40">Apply</button>
                )}
              </div>
              {couponError && <p className="mt-1 text-[12px] font-bold text-red-500">{couponError}</p>}
              {appliedCoupon && <p className="mt-1 text-[12px] font-bold text-emerald-600">Applied: -{formatCurrency(couponDiscount)}</p>}
            </div>

            {/* Total after coupon */}
            <div className="space-y-4 border-t border-gray-200 pt-5">
              <div className="flex items-center justify-between text-sm text-[#111111]">
                <span>Subtotal ({items.length} items)</span>
                <span className="font-black">{formatCurrency(subtotal)}</span>
              </div>
              {couponDiscount > 0 && (
                <div className="flex items-center justify-between text-sm text-[#111111]">
                  <span>Coupon{appliedCoupon?.code ? ` (${appliedCoupon.code})` : ''}</span>
                  <span className="font-black text-emerald-600">−{formatCurrency(couponDiscount)}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-sm font-black text-[#111111]">
                <span>Total</span>
                <span>{formatCurrency(Math.max(0, subtotal - couponDiscount))}</span>
              </div>
            </div>

            {/* Manual Discount */}
            <div>
              <label htmlFor="pos-manual-discount-value" className={posSideLabel}>Manual Discount</label>
              <div className="flex gap-2.5">
                <div className="relative shrink-0">
                  <select
                    id="pos-manual-discount-type"
                    name="manualDiscountType"
                    aria-label="Discount type"
                    value={manualDiscountType}
                    onChange={e => setManualDiscountType(e.target.value as 'flat' | 'percent')}
                    className="h-9 appearance-none rounded-xl border border-gray-200 bg-white pl-4 pr-9 text-[14px] font-black text-[#111111] focus:border-primary focus:outline-none"
                  >
                    <option value="flat">₹</option>
                    <option value="percent">%</option>
                  </select>
                  <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#111111]" />
                </div>
                <input
                  id="pos-manual-discount-value"
                  name="manualDiscountValue"
                  type="number"
                  onWheel={(e) => (e.target as HTMLInputElement).blur()}
                  value={manualDiscountValue}
                  onChange={e => setManualDiscountValue(e.target.value)}
                  placeholder="0"
                  className={`${posInput} text-right !font-black`}
                />
              </div>
            </div>

            {/* Total after manual discount */}
            {manualDiscountAmount > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-sm text-[#111111]">
                  <span>Discount</span>
                  <span className="font-black text-emerald-600">−{formatCurrency(manualDiscountAmount)}</span>
                </div>
                <div className="flex items-center justify-between text-sm font-black text-[#111111]">
                  <span>Total after discount</span>
                  <span>{formatCurrency(discountedSubtotal)}</span>
                </div>
              </div>
            )}

            {/* Non-GST bill / GST invoice */}
            <div className="grid grid-cols-2 gap-1.5 rounded-full border border-gray-200 p-1.5" role="tablist" aria-label="Bill type">
              <button type="button" role="tab" aria-selected={!billGstEnabled} onClick={() => setBillGstEnabled(false)} className={`h-10 rounded-full text-[10px] font-bold uppercase tracking-wider transition-colors ${!billGstEnabled ? 'bg-primary text-primary-ink' : 'text-[#111111] hover:bg-gray-50'}`}>Non-GST Bill</button>
              <button type="button" role="tab" aria-selected={billGstEnabled} onClick={() => setBillGstEnabled(true)} className={`h-10 rounded-full text-[10px] font-bold uppercase tracking-wider transition-colors ${billGstEnabled ? 'bg-primary text-primary-ink' : 'text-[#111111] hover:bg-gray-50'}`}>GST Invoice</button>
            </div>
            {billGstEnabled && (
              <div className="flex gap-2.5">
                <div className="relative shrink-0">
                  <select
                    id="pos-gst-type"
                    name="gstType"
                    aria-label="GST type"
                    value={gstType}
                    onChange={e => setGstType(e.target.value as 'flat' | 'percent')}
                    className="h-9 appearance-none rounded-xl border border-gray-200 bg-white pl-4 pr-9 text-[14px] font-black text-[#111111] focus:border-primary focus:outline-none"
                  >
                    <option value="percent">%</option>
                    <option value="flat">₹</option>
                  </select>
                  <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#111111]" />
                </div>
                <input
                  id="pos-gst-input"
                  name="gstInput"
                  type="number"
                  onWheel={(e) => (e.target as HTMLInputElement).blur()}
                  value={gstInput}
                  onChange={e => setGstInput(e.target.value)}
                  placeholder={gstType === 'percent' ? 'GST % e.g. 5' : 'GST amount'}
                  className={`${posInput} text-right !font-black`}
                />
              </div>
            )}
            {billGstEnabled && totalGst > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-sm text-[#111111]">
                  <span>Total GST{gstPctLabel(totalGst, discountedSubtotal)}</span>
                  <span className="font-black">{formatCurrency(totalGst)}</span>
                </div>
                <div className="flex items-center justify-between text-sm text-[#111111]">
                  <span>SGST{gstPctLabel(totalGst / 2, discountedSubtotal)}</span>
                  <span className="font-black">{formatCurrency(Math.round((totalGst - Math.round((totalGst / 2) * 100) / 100) * 100) / 100)}</span>
                </div>
                <div className="flex items-center justify-between text-sm text-[#111111]">
                  <span>CGST{gstPctLabel(totalGst / 2, discountedSubtotal)}</span>
                  <span className="font-black">{formatCurrency(Math.round((totalGst / 2) * 100) / 100)}</span>
                </div>
              </div>
            )}

            {/* Delivery */}
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm text-[#111111]">
                <label htmlFor="pos-shipping-input">Delivery</label>
                <input
                  id="pos-shipping-input"
                  name="shippingFee"
                  type="number"
                  onWheel={(e) => (e.target as HTMLInputElement).blur()}
                  value={shipping}
                  onChange={e => setShipping(e.target.value)}
                  className="h-10 w-24 rounded-xl border border-gray-200 px-3 text-right text-[14px] font-black text-[#111111] focus:border-primary focus:outline-none"
                />
              </div>
            </div>

            {/* Grand total */}
            <div className="flex items-center justify-between border-t border-gray-200 pt-5">
              <span className="text-base font-black tracking-tight uppercase tracking-wide text-[#111111]">Grand Total</span>
              <span className="text-xl font-black tracking-tight text-primary">{formatCurrency(total)}</span>
            </div>

            {/* Financial option */}
            <div>
              <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#111111]">Financial Option</p>
              <div className="grid grid-cols-4 gap-2">
                {(['cash', 'qr', 'card', 'split'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setPaymentType(mode)}
                    className={`h-9 rounded-xl border text-[10px] font-bold uppercase tracking-wider transition-colors ${
                      paymentType === mode ? 'border-primary bg-primary text-primary-ink' : 'border-gray-200 bg-white text-[#111111] hover:bg-gray-50'
                    }`}
                  >
                    {mode === 'qr' ? 'QR / GPay' : mode === 'card' ? 'Card' : mode === 'split' ? 'Split' : 'Cash'}
                  </button>
                ))}
              </div>
            </div>


            {ordermode !== 'online' && paymentType === 'split' && (
              <SplitPaymentInputs idPrefix="pos-split" total={total} value={splitForm} onChange={setSplitForm} allowChange />
            )}

            {ordermode !== 'online' && paymentType !== 'split' && (
              <div className="rounded-xl border border-gray-200 p-5">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#111111]">
                  {paymentType === 'qr' ? 'QR / GPay' : paymentType === 'card' ? 'Card' : 'Cash'} Payment
                </p>
                <label htmlFor="pos-cash-received" className="mb-3 block text-[13px] font-black text-[#111111]">Amount Received (₹)</label>
                <input
                  id="pos-cash-received"
                  name="cashReceived"
                  type="number"
                  onWheel={(e) => (e.target as HTMLInputElement).blur()}
                  value={cashReceived}
                  onChange={e => setCashReceived(e.target.value)}
                  placeholder="0.00"
                  className="h-10 w-full rounded-xl border border-gray-200 px-4 text-base font-black text-[#111111] placeholder:text-[#111111] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
                />
                {cashReceivedNum > 0 && (
                  <div className="mt-3 flex items-center justify-between rounded-xl bg-gray-50 px-4 py-2.5">
                    <span className="text-[13px] font-bold text-[#111111]">Return Balance</span>
                    <span className="text-sm font-black text-[#111111]">{formatCurrency(balanceToReturn)}</span>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] font-bold text-red-600">{error}</div>
            )}

            <div className="space-y-4">
              <button
                type="button"
                onClick={generateBill}
                disabled={saving}
                className="inline-flex h-9 w-full items-center justify-center gap-3 rounded-xl bg-primary text-[11px] font-black uppercase tracking-[0.16em] text-primary-ink shadow-[0_12px_24px_-10px_rgb(var(--primary)/0.7)] transition hover:bg-primary-hover active:scale-[0.99] disabled:opacity-50"
              >
                <Check size={19} strokeWidth={2.5} />
                {saving ? 'Processing...' : 'Complete Sale'}
              </button>
              <button
                type="button"
                onClick={openDepositOrder}
                disabled={saving || items.length === 0}
                className="inline-flex h-9 w-full items-center justify-center gap-3 rounded-xl border-2 border-amber-500 bg-white text-[11px] font-black uppercase tracking-[0.16em] text-amber-600 transition hover:bg-amber-50 disabled:opacity-40"
              >
                <Clock size={19} strokeWidth={2} />
                Save as Advance Order
              </button>
              <p className="text-center text-[11.5px] font-medium text-gray-500">Advance orders count as revenue only when the balance is collected.</p>
            </div>
          </div>
        </aside>
      </div>

      {depositOpen && (
        createPortal(<div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-0 sm:p-4">
          <form onSubmit={saveDepositOrder} className="h-[100dvh] max-h-[100dvh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-none bg-white p-4 pb-0 shadow-2xl sm:h-auto sm:max-h-[94dvh] sm:rounded-3xl sm:p-6 sm:pb-0">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[.16em] text-gray-600">Advance payment only</p>
                <h3 className="text-xl font-black text-[#111111]">Save as Deposit Order</h3>
                <p className="mt-1 text-xs font-semibold text-amber-700">No sale or tax invoice will be created now.</p>
              </div>
              <button type="button" onClick={() => { setDepositOpen(false); setError('') }} className="rounded-lg p-1 text-gray-500 hover:bg-gray-100"><X size={20}/></button>
            </div>
            <div className="mb-4 rounded-2xl bg-gray-50 p-4">
              <div className="flex justify-between text-sm"><span className="font-bold text-gray-700">Order total</span><span className="font-black text-gray-900">{formatCurrency(total)}</span></div>
              <div className="mt-2 max-h-24 space-y-1 overflow-y-auto border-t border-gray-200 pt-2">{items.map(item => <div key={item.id} className="flex justify-between gap-3 text-xs"><span className="truncate">{item.qty}× {item.name}</span><span className="font-bold">{formatCurrency(item.lineTotal)}</span></div>)}</div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label htmlFor="pos-deposit-amount" className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Deposit received *</span><input id="pos-deposit-amount" name="depositAmount" required autoFocus type="number" onWheel={(e) => (e.target as HTMLInputElement).blur()} min="0.01" max={Math.max(0, total - 0.01)} step="0.01" value={depositForm.amount} onChange={e => setDepositForm({...depositForm, amount:e.target.value})} className="w-full rounded-xl border px-3 py-2.5 text-sm font-bold outline-none focus:border-gray-600"/></label>
              <div className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Remaining balance</span><div className="rounded-xl bg-red-50 px-3 py-2.5 text-sm font-black text-red-700">{formatCurrency(Math.max(0,total-Number(depositForm.amount||0)))}</div></div>
              <label htmlFor="pos-deposit-delivery-date" className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Expected delivery *</span><input id="pos-deposit-delivery-date" name="deliveryDate" required type="date" value={depositForm.expectedDeliveryDate} onChange={e => setDepositForm({...depositForm, expectedDeliveryDate:e.target.value})} className="w-full rounded-xl border px-3 py-2.5 text-sm font-bold outline-none focus:border-gray-600"/></label>
              <label htmlFor="pos-deposit-payment-method" className="block"><span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Payment method *</span><select id="pos-deposit-payment-method" name="paymentMethod" value={depositForm.paymentMethod} onChange={e => setDepositForm({...depositForm,paymentMethod:e.target.value as AdvancePaymentMethod})} className="w-full rounded-xl border px-3 py-2.5 text-sm font-bold outline-none focus:border-gray-600"><option value="cash">Cash</option><option value="upi">QR</option><option value="card">Card</option><option value="split">Split (Cash / QR / Card)</option></select></label>
              {depositForm.paymentMethod === 'split' && (<div className="sm:col-span-2"><SplitPaymentInputs idPrefix="pos-deposit-split" total={Number(depositForm.amount) || 0} value={depositSplit} onChange={setDepositSplit} /></div>)}
              <label htmlFor="pos-deposit-address" className="block sm:col-span-2"><span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Delivery address</span><textarea id="pos-deposit-address" name="deliveryAddress" autoComplete="street-address" value={depositForm.address} onChange={e => setDepositForm({...depositForm,address:e.target.value})} className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-gray-600" rows={2}/></label>
              <label htmlFor="pos-deposit-reference" className="block sm:col-span-2"><span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Reference Number (Internal)</span><input id="pos-deposit-reference" name="depositReference" value={depositForm.referenceNumber} onChange={e => setDepositForm({...depositForm,referenceNumber:e.target.value})} maxLength={60} placeholder="e.g. REF-1002" className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-gray-600"/></label>
              <label htmlFor="pos-deposit-remarks" className="block sm:col-span-2"><span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#6B7280]">Remarks (Internal)</span><textarea id="pos-deposit-remarks" name="depositRemarks" value={depositForm.remarks} onChange={e => setDepositForm({...depositForm,remarks:e.target.value})} className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-gray-600" rows={2}/></label>
            </div>
            {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-600">{error}</div>}
            <div className="sticky bottom-0 z-10 -mx-4 mt-5 flex gap-3 border-t border-gray-100 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 sm:pb-6"><button type="button" onClick={() => { setDepositOpen(false); setError('') }} className="flex-1 rounded-xl border py-3 text-sm font-black">Cancel</button><button disabled={saving} className="flex-[1.5] rounded-xl bg-gray-700 py-3 text-sm font-black text-white disabled:opacity-50">{saving ? 'Saving…' : 'Confirm Deposit Order'}</button></div>
          </form>
        </div>, document.body)
      )}

      <PrintSettingsModal open={depositPrintProps !== null} onClose={() => setDepositPrintProps(null)} onPrint={(settings) => { if (depositPrintProps) printBill(depositPrintProps, settings) }} />
      {depositCreated && (
        createPortal(<div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto flex h-10 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl">✓</div>
            <p className="mt-4 text-[11px] font-black uppercase tracking-[.16em] text-gray-600">Deposit order saved</p>
            <h3 className="mt-1 text-2xl font-black text-[#111111]">{depositCreated.deposit_id}</h3>
            <p className="mt-2 text-sm text-[#6B7280]">Deposit {formatCurrency(depositCreated.deposit_amount)} · Balance {formatCurrency(depositCreated.remaining_balance)}</p>
            <div className="mt-5 grid grid-cols-2 gap-2"><button onClick={() => { const order = depositCreated; void getAdvanceOrderHistory(order.id).then(h => h.payments, () => []).then(payments => setDepositPrintProps(advanceReceiptProps(order, payments))) }} className="rounded-xl border border-gray-200 py-3 text-sm font-black text-gray-700"><Printer size={16} className="mr-1 inline"/>Print Receipt</button><button onClick={() => { const msg = buildAdvanceDepositWhatsAppMessage({ customerName: depositCreated.customer_name, depositId: depositCreated.deposit_id, productName: depositCreated.product_name, totalAmount: depositCreated.total_amount, depositAmount: depositCreated.deposit_amount, remainingBalance: depositCreated.remaining_balance, expectedDeliveryDate: depositCreated.expected_delivery_date }); window.open(toWhatsAppUrl(depositCreated.phone, msg), '_blank', 'noopener,noreferrer') }} className="rounded-xl bg-[#25D366] py-3 text-sm font-black text-white"><MessageCircle size={16} className="mr-1 inline -mt-0.5"/>WhatsApp</button></div>
            <button onClick={() => { setDepositCreated(null); searchRef.current?.focus() }} className="mt-3 w-full rounded-xl bg-primary py-3 text-sm font-black text-white">Start New Order</button>
          </div>
        </div>, document.body)
      )}

      {catalogOpen && (
        <CatalogModal
          isOpen={catalogOpen}
          onClose={() => setCatalogOpen(false)}
          onAdd={(p) => {
            void addItem(p)
            setCatalogOpen(false)
          }}
        />
      )}

      <AddProductModal
        isOpen={addToCatalogOpen}
        onClose={() => setAddToCatalogOpen(false)}
        onSuccess={() => { setAddToCatalogOpen(false); void fetchProducts(true) }}
      />

      {/* Variant Picker Modal for Multi-Variant Products */}
      {variantPickerProduct && (
        createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
          <div className="bg-white rounded-3xl max-w-md w-full border border-[#F3F4F6] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">
            <div className="p-4 border-b border-[#111111]/20 flex items-center justify-between bg-primary text-white">
              <div>
                <h3 className="text-sm font-black uppercase tracking-wider text-white">
                  Select Variant / Size
                </h3>
                <p className="text-xs text-primary-hover font-bold">
                  {variantPickerProduct.name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setVariantPickerProduct(null)
                  setAvailableVariants([])
                }}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white cursor-pointer transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="space-y-2">
                <label className="block text-[11px] font-black uppercase tracking-wider text-gray-600">
                  Available Sizes &amp; Options ({availableVariants.length})
                </label>
                <div className="grid grid-cols-2 gap-2.5 max-h-52 overflow-y-auto pr-1">
                  {availableVariants.map((v) => (
                    <div
                      key={v.id}
                      onClick={() => setSelectedVariant(v)}
                      className={`p-3 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between ${
                        selectedVariant?.id === v.id
                          ? 'border-[#111111] bg-[#F9FAFB] shadow-xs'
                          : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className="font-black text-xs text-gray-900">
                        {v.variantName}
                      </div>
                      <div className="flex items-center justify-between mt-2 pt-1 border-t border-gray-100 text-[11px]">
                        <span className="font-black text-[#111111]">
                          {variantOfferPrice(variantPickerProduct.price, variantPickerProduct.offerPrice, v.price) != null ? (
                            <>
                              <span className="mr-1 text-[10px] font-bold text-gray-400 line-through">₹{v.price}</span>
                              ₹{variantOfferPrice(variantPickerProduct.price, variantPickerProduct.offerPrice, v.price)}
                            </>
                          ) : `₹${v.price}`}
                        </span>
                        <span className="text-[10px] text-emerald-700 font-bold">Stock: {v.stock}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quantity Stepper */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-[#F9FAFB] border border-gray-200">
                <span className="text-xs font-black uppercase tracking-wider text-gray-700">Quantity</span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setVariantPickerQty((q) => Math.max(1, q - 1))}
                    className="w-8 h-8 rounded-xl border border-gray-300 bg-white font-black text-sm flex items-center justify-center hover:bg-gray-100 cursor-pointer"
                  >
                    -
                  </button>
                  <span className="font-black text-sm text-black min-w-[20px] text-center">
                    {variantPickerQty}
                  </span>
                  <button
                    type="button"
                    onClick={() => setVariantPickerQty((q) => q + 1)}
                    className="w-8 h-8 rounded-xl border border-gray-300 bg-white font-black text-sm flex items-center justify-center hover:bg-gray-100 cursor-pointer"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Add Button */}
              <button
                type="button"
                onClick={addVariantToItems}
                className="w-full py-3 rounded-2xl bg-primary hover:bg-primary-hover border border-primary-soft/50 text-primary-100 text-xs font-black uppercase tracking-wider transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
              >
                Add to Order (₹{(((selectedVariant ? variantOfferPrice(variantPickerProduct.price, variantPickerProduct.offerPrice, selectedVariant.price) : null) ?? selectedVariant?.price ?? variantPickerProduct.price ?? 0) * variantPickerQty).toFixed(2)})
              </button>
            </div>
          </div>
        </div>, document.body)
      )}

      {/* Price Edit & Inventory Confirmation Modal */}
      {priceEditModal.isOpen && priceEditModal.item && (
        createPortal(<div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-amber-50/50 to-white">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-primary-soft/10 flex items-center justify-center text-primary-hover">
                  <Edit2 size={16} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-900">Edit Item Price</h3>
                  <p className="text-xs text-gray-500 truncate max-w-[260px]">{priceEditModal.item.name}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClosePriceEdit}
                className="w-8 h-8 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex items-center justify-center transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider">
                    New Price (₹)
                  </label>
                  <span className="text-[11px] text-gray-500 font-semibold">
                    Current: ₹{Number(priceEditModal.item.basePrice || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 font-bold text-base">₹</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    autoFocus
                    value={priceEditModal.newPrice}
                    onChange={(e) => setPriceEditModal(prev => ({ ...prev, newPrice: e.target.value, error: '' }))}
                    placeholder="0.00"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void handleSavePrice(false)
                      }
                    }}
                    className="w-full h-10 pl-8 pr-4 bg-gray-50 border-2 border-gray-200 rounded-xl text-lg font-black text-gray-900 focus:outline-none focus:border-primary-soft focus:bg-white transition-all"
                  />
                </div>
                {priceEditModal.error && (
                  <p className="text-xs font-semibold text-red-500 mt-1.5">{priceEditModal.error}</p>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200/60 text-xs text-amber-900 space-y-1">
                <p className="font-bold flex items-center gap-1.5 text-amber-800">
                  <AlertCircle size={14} className="shrink-0 text-primary-hover" />
                  Do you want to update this price in inventory also?
                </p>
                <p className="text-[11px] text-amber-700/90 pl-5 leading-relaxed">
                  Selecting <strong>Yes</strong> updates the price in your master product catalog and inventory database. Selecting <strong>No</strong> updates it for this billing session only.
                </p>
              </div>

              <div className="pt-2 grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={priceEditModal.isSubmitting}
                  onClick={() => void handleSavePrice(true)}
                  className="h-9 px-3 bg-primary hover:bg-primary-hover text-primary-100 border border-primary-soft/50 font-bold text-xs rounded-xl shadow-sm hover:shadow transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  {priceEditModal.isSubmitting ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <Check size={14} />
                  )}
                  <span>Yes (Update Inventory)</span>
                </button>

                <button
                  type="button"
                  disabled={priceEditModal.isSubmitting}
                  onClick={() => void handleSavePrice(false)}
                  className="h-9 px-3 bg-gray-100 hover:bg-gray-200 text-gray-800 font-bold text-xs rounded-xl transition-all flex items-center justify-center gap-1 disabled:opacity-50 cursor-pointer"
                >
                  <span>No (This Bill Only)</span>
                </button>
              </div>

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={handleClosePriceEdit}
                  className="text-xs font-semibold text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>, document.body)
      )}
    </div>
  )
}
