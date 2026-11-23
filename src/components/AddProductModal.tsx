import React, { useEffect, useState } from 'react'
import { X, PackagePlus, Tag, Plus, Trash2 } from 'lucide-react'
import { useProductStore } from '../store/store'
import { db } from '../lib/db'
import { normalizeBarcode } from '../lib/barcode'
import { createPortal } from 'react-dom'

interface VariantRow { id: string; name: string; price: string; cost: string; stock: string; barcode: string }
const newVariant = (): VariantRow => ({ id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: '', price: '', cost: '', stock: '0', barcode: '' })

interface AddProductModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

const emptyForm = {
  name: '',
  nameTa: '',
  barcode: '',
  description: '',
  category: '',
  lowStockAlert: '0',
  price: '',
  cost: '',
  stock: '0',
  active: true,
}

const label = 'mb-2 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#374151]'
const input =
  'h-10 w-full rounded-xl border border-gray-200 bg-white px-4 text-sm font-semibold text-[#111111] placeholder:font-medium placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15'
const help = 'mt-1.5 text-[11.5px] font-medium leading-snug text-gray-400'


export default function AddProductModal({ isOpen, onClose, onSuccess }: AddProductModalProps) {
  const { fetchProducts, products } = useProductStore()
  const [form, setForm] = useState(emptyForm)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [categoryOptions, setCategoryOptions] = useState<string[]>([])
  const [hasVariants, setHasVariants] = useState(false)
  const [variants, setVariants] = useState<VariantRow[]>([])

  const existingCategories = categoryOptions.length > 0
    ? categoryOptions
    : Array.from(new Set(products.filter(p => p.category).map(p => p.category))).filter(Boolean).sort()

  useEffect(() => {
    if (!isOpen) return
    setForm(emptyForm)
    setHasVariants(false)
    setVariants([])
    setError('')
    let cancelled = false
    void db.from('categories').select('name_en').eq('is_active', true).order('sort_order').then(({ data }) => {
      if (!cancelled) setCategoryOptions((data || []).map(row => String(row.name_en || '')).filter(Boolean))
    })
    return () => { cancelled = true }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const set = (key: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }))

  const setPrice = (v: string) => setForm(f => ({ ...f, price: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const useVariants = hasVariants
    const validVariants = useVariants ? variants.filter(v => v.name.trim()) : []
    if (useVariants && validVariants.length === 0) return setError('Add at least one variant (e.g. Size S, 32, Red)')
    const price = Number(form.price) || (useVariants ? Number(validVariants[0].price) || 0 : 0)
    if (!form.name.trim()) return setError('Product name is required')
    if (!price || price <= 0) return setError('Price must be greater than 0')

    setLoading(true)
    setError('')
    try {
      const categoryName = form.category.trim()
      let categoryId: string | number | null = null
      if (categoryName) {
        const { data: existingCategory, error: lookupError } = await db
          .from('categories').select('id').ilike('name_en', categoryName).maybeSingle()
        if (lookupError) throw lookupError
        categoryId = existingCategory?.id ?? null
        if (!existingCategory) {
          const { data: inserted, error: insertError } = await db
            .from('categories').insert({ name_en: categoryName, name_ta: '', is_active: true }).select('id').single()
          if (insertError) throw insertError
          categoryId = inserted?.id ?? null
        }
      }

      const variantStock = validVariants.reduce((sum, v) => sum + Math.max(0, parseInt(v.stock) || 0), 0)
      const stockNum = useVariants ? variantStock : Math.max(0, parseInt(form.stock) || 0)
      const productBarcode = useVariants ? '' : form.barcode.trim()
      const { data: newProd, error: dbErr } = await db
        .from('products')
        .insert({
          name: form.name.trim(),
          name_ta: form.nameTa.trim(),
          barcode: productBarcode || null,
          has_variants: useVariants,
          description: form.description.trim(),
          category: categoryName || 'General',
          category_id: categoryId,
          price,
          offer_price: null,
          purchase_price: Number(form.cost) || 0,
          stock: stockNum,
          stock_quantity: stockNum,
          low_stock_alert: Math.max(0, parseInt(form.lowStockAlert) || 0),
          is_active: form.active,
          unit: '1pc',
          base_quantity: 1,
          unit_type: 'unit',
          unit_label: 'pc',
        })
        .select('id')
        .single()
      if (dbErr) throw dbErr

      if (newProd && normalizeBarcode(productBarcode)) {
        await db.from('barcode_registry').upsert(
          {
            barcode_value: normalizeBarcode(productBarcode),
            product_id: newProd.id,
            variant_id: null,
            is_active: true,
          },
          { onConflict: 'barcode_value' }
        )
      }

      if (newProd && useVariants) {
        const baseCost = Number(form.cost) || 0
        for (const v of validVariants) {
          const vPrice = Number(v.price) > 0 ? Number(v.price) : price
          const vCost = Number(v.cost) > 0 ? Number(v.cost) : baseCost
          const vStock = Math.max(0, parseInt(v.stock) || 0)
          const { data: createdVar } = await db
            .from('product_variants')
            .insert({
              product_id: newProd.id,
              variant_name: v.name.trim(),
              size_label: v.name.trim(),
              price: vPrice,
              purchase_price: vCost,
              stock: vStock,
              barcode: v.barcode.trim() || null,
              is_active: true,
            })
            .select('id')
            .single()

          if (createdVar && normalizeBarcode(v.barcode)) {
            await db.from('barcode_registry').upsert(
              {
                barcode_value: normalizeBarcode(v.barcode),
                product_id: newProd.id,
                variant_id: createdVar.id,
                is_active: true,
              },
              { onConflict: 'barcode_value' }
            )
          }

          if (createdVar && vStock > 0) {
            await db.from('inventory_movements').insert({
              product_id: newProd.id,
              variant_id: createdVar.id,
              movement_type: 'RESTOCK',
              quantity_delta: vStock,
              quantity_before: 0,
              quantity_after: vStock,
              unit_cost: vCost || null,
              reference_type: 'PRODUCT_CREATION',
              note: `Initial stock for variant ${v.name.trim()}`,
              created_by_name: 'Admin',
            })
          }
        }
      }

      if (newProd && stockNum > 0 && !useVariants) {
        await db.from('inventory_movements').insert({
          product_id: newProd.id,
          variant_id: null,
          movement_type: 'RESTOCK',
          quantity_delta: stockNum,
          quantity_before: 0,
          quantity_after: stockNum,
          reference_type: 'PRODUCT_CREATION',
          note: 'Initial received stock on product creation',
          created_by_name: 'Admin',
        })
      }

      await fetchProducts(true)
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add product')
    } finally {
      setLoading(false)
    }
  }

  return (
    createPortal(<div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-0 sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-item-title"
        className="flex h-[100dvh] max-h-[100dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-none bg-white shadow-2xl sm:h-auto sm:max-h-[94dvh] sm:rounded-[26px]"
      >
        <div className="flex shrink-0 items-center gap-4 border-b border-gray-200 px-5 py-4 sm:px-7 sm:py-5">
          <span className="flex h-10 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary"><PackagePlus size={24} strokeWidth={1.75} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="add-item-title" className="text-base font-black tracking-tight text-[#111111]">Add New Product</h2>
            <p className="text-[13px] font-medium text-gray-500">Set pricing, stock and category for this item</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-500 hover:text-[#111111]"><X size={20} /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7 sm:py-6">
          <label className="block">
            <span className={label}>Product name <span className="text-[#DC2626]">*</span></span>
            <input className={input} value={form.name} onChange={set('name')} autoFocus maxLength={120}
              placeholder="e.g., Cotton Shirt / Silk Saree" />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className={label}>Tamil name (optional)</span>
              <input className={input} value={form.nameTa} onChange={set('nameTa')} maxLength={120} placeholder="e.g., காட்டன் சட்டை" />
            </label>
            <label className="block">
              <span className={label}>Barcode (optional)</span>
              <input className={`${input} disabled:bg-gray-100 disabled:text-gray-400`} value={form.barcode} onChange={set('barcode')} maxLength={64}
                disabled={hasVariants} placeholder={hasVariants ? 'Defined at variant level' : 'e.g., 8901234567'} />
            </label>
          </div>

          <label className="block">
            <span className={label}>Description / notes (optional)</span>
            <input className={input} value={form.description} onChange={set('description')} maxLength={300}
              placeholder="e.g., Pure cotton, size 40, navy blue" />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className={label}>Category</span>
              <input className={input} value={form.category} onChange={set('category')} list="add-item-categories" placeholder="e.g., Shirts, Sarees" />
              <datalist id="add-item-categories">{existingCategories.map(c => <option key={c} value={c} />)}</datalist>
              <p className={help}>Pick an existing category or type a new one (it will be added automatically)</p>
            </label>
              <label className="block">
                <span className={label}>Low stock alert</span>
                <input className={input} value={form.lowStockAlert} onChange={set('lowStockAlert')} inputMode="numeric" />
                <p className={help}>Warns you in Inventory when stock falls to this level.</p>
              </label>
          </div>

          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
            <label className="block">
              <span className={label}>Original price (₹) <span className="text-[#DC2626]">*</span></span>
              <input className={input} value={form.price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.00" />
            </label>
            <label className="block">
              <span className={label}>Cost price (₹)</span>
              <input className={input} value={form.cost} onChange={set('cost')} inputMode="decimal" placeholder="0.00" />
              <p className={help}>For your records only — never used in billing.</p>
            </label>
              <label className="block">
                <span className={label}>Current stock{hasVariants ? ' (from variants)' : ''}</span>
                <input className={`${input} disabled:bg-gray-100 disabled:text-gray-400`} value={hasVariants ? String(variants.reduce((n, v) => n + Math.max(0, parseInt(v.stock) || 0), 0)) : form.stock} onChange={set('stock')} disabled={hasVariants} inputMode="numeric" />
              </label>
          </div>

            <div className="rounded-2xl border border-gray-200 p-5">
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span>
                  <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#374151]"><Tag size={16} strokeWidth={1.75} /> Multi-variant product (sizes, colours, SKUs)</span>
                  <span className={`${help} block`}>Enable if this product comes in multiple sizes (e.g. S, M, L, XL) or colours</span>
                </span>
                <input
                  type="checkbox"
                  checked={hasVariants}
                  onChange={(e) => {
                    setHasVariants(e.target.checked)
                    if (e.target.checked && variants.length === 0) setVariants([newVariant()])
                  }}
                  className="h-5 w-5 shrink-0 rounded accent-[rgb(var(--primary))]"
                />
              </label>
              {hasVariants && (
                <div className="mt-4 space-y-3">
                  {variants.map((v, i) => {
                    const upd = (key: keyof VariantRow) => (e: React.ChangeEvent<HTMLInputElement>) =>
                      setVariants(rows => rows.map(r => (r.id === v.id ? { ...r, [key]: e.target.value } : r)))
                    return (
                      <div key={v.id} className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-3.5">
                        <div className="flex items-end gap-2">
                          <label className="block min-w-0 flex-1"><span className={label}>Variant {i + 1}</span><input className={input} value={v.name} onChange={upd('name')} placeholder="e.g., M / 32 / Red" /></label>
                          <button type="button" onClick={() => setVariants(rows => rows.filter(r => r.id !== v.id))} aria-label={`Remove variant ${i + 1}`}
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 hover:bg-red-50 hover:text-[#DC2626]"><Trash2 size={17} /></button>
                        </div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <label className="block min-w-0"><span className={label}>Price (₹)</span><input className={input} value={v.price} onChange={upd('price')} inputMode="decimal" placeholder={form.price || '0.00'} /></label>
                          <label className="block min-w-0"><span className={label}>Cost (₹)</span><input className={input} value={v.cost} onChange={upd('cost')} inputMode="decimal" placeholder={form.cost || '0.00'} /></label>
                          <label className="block min-w-0"><span className={label}>Stock</span><input className={input} value={v.stock} onChange={upd('stock')} inputMode="numeric" /></label>
                          <label className="block min-w-0"><span className={label}>Barcode</span><input className={input} value={v.barcode} onChange={upd('barcode')} placeholder="Optional" /></label>
                        </div>
                      </div>
                    )
                  })}
                  <button type="button" onClick={() => setVariants(rows => [...rows, newVariant()])}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-dashed border-gray-300 px-4 text-[11px] font-black uppercase tracking-[0.1em] text-[#374151] hover:bg-gray-50">
                    <Plus size={15} /> Add variant
                  </button>
                  <p className={help}>Blank variant price or cost uses the product's original / cost price. Product stock is the total of all variants.</p>
                </div>
              )}
            </div>

          <label className="flex items-center gap-3 rounded-2xl border border-gray-200 px-5 py-4 text-sm font-bold text-[#374151]">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm(f => ({ ...f, active: e.target.checked }))} className="h-5 w-5 rounded accent-[rgb(var(--primary))]" />
            Active (visible in Billing Panel)
          </label>

          {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-[13px] font-bold text-[#B91C1C]">{error}</p>}
        </div>

        <div className="shrink-0 border-t border-gray-100 bg-white px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-7 sm:py-5">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-9 w-full items-center justify-center gap-3 rounded-2xl bg-primary text-[11px] font-black uppercase tracking-[0.14em] text-primary-ink shadow-md hover:bg-primary-hover disabled:opacity-60"
          >
            <PackagePlus size={19} strokeWidth={1.75} />
            {loading ? 'Saving…' : 'Save Product to Catalog'}
          </button>
        </div>
      </form>
    </div>, document.body)
  )
}
