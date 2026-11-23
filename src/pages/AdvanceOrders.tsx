import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Download, Eye, Plus, FileText, MessageCircle, Printer, RefreshCw, Search, X, Trash2, IndianRupee, Box, Wallet, Clock } from 'lucide-react'
import { formatCurrency, formatInvoiceNo } from '../lib/retail'
import SplitPaymentInputs from '../components/common/SplitPaymentInputs'
import { emptySplitInput, formatPaymentLabel, splitInputToDetails, splitTotal, type SplitInputValue } from '../lib/payments'
import PrintSettingsModal from '../components/print/PrintSettingsModal'
import InvoicePreviewModal from '../components/print/InvoicePreviewModal'
import { invoicePdfFromProps, printBill } from '../lib/billPrint'
import { advanceDocumentProps } from '../lib/advanceInvoice'
import type { InvoiceProps } from '../components/Invoice'
import { buildAdvanceDepositWhatsAppMessage, buildProfessionalWhatsAppMessage, publicInvoiceUrl } from '../lib/whatsappMessage'
import { formatPhoneDisplay, toWhatsAppUrl } from '../lib/phone'
import { downloadFile, paymentLines } from '../lib/advanceReceipt'
import { advanceBreakdown, advanceBreakdownRows, computeAdvanceTotals } from '../lib/advanceBreakdown'
import { useAdminAuthStore, useProductStore } from '../store/store'
import {
  addAdvanceEvent, completeAdvanceOrder, updateAdvanceInternalNotes, createAdvanceOrder, getAdvanceOrderHistory, listAdvanceOrders, updateAdvanceStatus, deleteAdvanceOrder,
  type AdvanceOrder, type AdvancePayment, type AdvancePaymentMethod, type AdvanceStatus, type AdvanceTimeline,
} from '../services/advanceOrderService'
import { confirmDelete } from '../lib/confirmDelete'

// Custom Malaysian Ringgit icon
const RMIcon = ({ size = 20, className = '' }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-label="Malaysian Ringgit">
    <rect x="2" y="2" width="20" height="20" rx="4" />
    <text x="12" y="16" textAnchor="middle" fontSize="9" fontWeight="bold" stroke="none" fill="currentColor" fontFamily="Arial, sans-serif">₹</text>
  </svg>
)

type DateFilter = 'all' | 'today' | 'week' | 'month' | 'year' | 'custom'
type StatusFilter = 'all' | 'pending' | 'ready' | 'completed' | 'cancelled'

const STATUS_LABELS: Record<AdvanceStatus, string> = {
  pending_deposit: 'Pending Deposit', ready_for_delivery: 'Ready for Delivery', waiting_final_payment: 'Waiting for Final Payment', completed: 'Completed', cancelled: 'Cancelled',
}
const STATUS_STYLES: Record<AdvanceStatus, string> = {
  pending_deposit: 'bg-amber-50 text-amber-700 border-amber-200', ready_for_delivery: 'bg-gray-50 text-gray-700 border-gray-200',
  waiting_final_payment: 'bg-gray-50 text-gray-700 border-gray-200', completed: 'bg-emerald-50 text-emerald-700 border-emerald-200', cancelled: 'bg-red-50 text-red-700 border-red-200',
}
const initialForm = { customerName: '', phone: '', address: '', productName: '', category: '', description: '', totalAmount: '', deliveryCharge: '', discount: '', gstEnabled: false, gstRate: '5', depositAmount: '', expectedDeliveryDate: '', status: 'pending_deposit' as AdvanceStatus, remarks: '', reference_number: '', paymentMethod: 'cash' as AdvancePaymentMethod }
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

type AdvanceOrdersProps = {
  onOrderCompleted?: (order?: AdvanceOrder) => void
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) { return <label htmlFor={htmlFor} className="block"><span className="mb-1.5 block text-[11px] font-black uppercase tracking-wide text-[#6B7280]">{label}</span>{children}</label> }
const inputClass = 'w-full rounded-xl border border-[#F3F4F6] bg-white px-3.5 py-2.5 text-sm text-[#1F1F1F] outline-none transition focus:border-[#6B7280] focus:ring-2 focus:ring-gray-100'

export default function AdvanceOrders({ onOrderCompleted }: AdvanceOrdersProps = {}) {
  const role = useAdminAuthStore(state => state.role)
  const products = useProductStore(state => state.products)
  const [orders, setOrders] = useState<AdvanceOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState(initialForm)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selected, setSelected] = useState<AdvanceOrder | null>(null)
  // Shop-only reference number / remarks being edited in the details drawer
  const [internalNotes, setInternalNotes] = useState({ reference: '', remarks: '' })
  const [savingNotes, setSavingNotes] = useState(false)
  useEffect(() => {
    setInternalNotes({ reference: selected?.reference_number || '', remarks: selected?.remarks || '' })
  }, [selected?.id, selected?.reference_number, selected?.remarks])
  const [timeline, setTimeline] = useState<AdvanceTimeline[]>([])
  const [payments, setPayments] = useState<AdvancePayment[]>([])
  const [paymentOrder, setPaymentOrder] = useState<AdvanceOrder | null>(null)
  const [printProps, setPrintProps] = useState<InvoiceProps | null>(null)
  const [preview, setPreview] = useState<{ order: AdvanceOrder; props: InvoiceProps } | null>(null)
  // Shown after the final payment instead of jumping straight to WhatsApp
  const [finalBill, setFinalBill] = useState<{ order: AdvanceOrder; props: InvoiceProps; received: number; method: string } | null>(null)
  const [paymentForm, setPaymentForm] = useState({ method: 'cash' as AdvancePaymentMethod, remarks: '' })
  const [depositSplit, setDepositSplit] = useState<SplitInputValue>(emptySplitInput())
  const [finalSplit, setFinalSplit] = useState<SplitInputValue>(emptySplitInput())

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setOrders(await listAdvanceOrders()) } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load advance orders') } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const handleDeleteOrder = async (orderId: string, orderName: string) => {
    if (role === 'staff') return // staff cannot delete advance orders
    const adv = orders.find(o => o.id === orderId)
    const ok = await confirmDelete({
      title: `Permanently Delete Advance Order${adv ? ` #${adv.deposit_id}` : ''}`,
      subtitle: adv ? `Customer: ${adv.customer_name || orderName} • Date: ${new Date(adv.created_at).toLocaleDateString('en-GB')}` : `Customer: ${orderName}`,
      warning: 'This advance order, all its deposit payments and its timeline will be permanently deleted from the Neon database.',
      impact: [
        { label: 'Deposit ID', value: adv ? `#${adv.deposit_id}` : '—' },
        { label: 'Customer', value: adv?.customer_name || orderName },
        { label: 'Order Total', value: formatCurrency(adv?.total_amount || 0), tone: 'danger' },
        { label: 'Deposits Received', value: `${formatCurrency(adv?.deposit_amount || 0)} — payment records purged`, tone: 'danger' },
        { label: 'Final Bill', value: adv?.invoice_number ? `Bill #${adv.invoice_number} is kept` : 'No final bill yet', tone: adv?.invoice_number ? 'success' : 'default' },
      ],
    })
    if (!ok) return
    try {
      await deleteAdvanceOrder(orderId)
      setOrders(orders => orders.filter(o => o.id !== orderId))
      setNotice('Order deleted successfully')
      setTimeout(() => setNotice(''), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete order')
    }
  }

  // Close modals or drawer on Escape key
  useEffect(() => {
    if (!selected && !createOpen && !paymentOrder) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null)
        else if (paymentOrder) setPaymentOrder(null)
        else if (createOpen) setCreateOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected, createOpen, paymentOrder])

  // Prevent background scroll when modal or drawer is open
  useEffect(() => {
    const isAnyOpen = !!(selected || createOpen || paymentOrder)
    if (isAnyOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [selected, createOpen, paymentOrder])

  const openDetails = async (order: AdvanceOrder) => {
    setSelected(order); setTimeline([]); setPayments([])
    try { const history = await getAdvanceOrderHistory(order.id); setTimeline(history.timeline); setPayments(history.payments) } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load order details') }
  }

  // The period / date-range filter drives the summary boxes as well as the table
  const inPeriod = useMemo(() => orders.filter(order => {
    if (dateFilter === 'all') return true
    const created = new Date(order.created_at); const now = new Date()
    if (dateFilter === 'today') return dateKey(created) === dateKey(now)
    if (dateFilter === 'week') return created >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
    if (dateFilter === 'month') return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear()
    if (dateFilter === 'year') return created.getFullYear() === now.getFullYear()
    const key = dateKey(created)
    if (dateFrom && key < dateFrom) return false
    if (dateTo && key > dateTo) return false
    return true
  }), [orders, dateFilter, dateFrom, dateTo])

  const analytics = useMemo(() => {
    const live = inPeriod.filter(o => o.status !== 'cancelled')
    // Orders still open (deposit taken, balance not yet collected)
    const open = live.filter(o => o.status !== 'completed')
    return {
      openCount: open.length,
      openDeposits: open.reduce((sum, o) => sum + o.deposit_amount, 0),
      openBalanceCount: open.filter(o => o.remaining_balance > 0).length,
      total: inPeriod.length,
      pending: inPeriod.filter(o => o.status === 'pending_deposit' || o.status === 'waiting_final_payment').length,
      orderValue: live.reduce((sum, o) => sum + o.total_amount, 0),
      // a completed order has had its balance collected, so it is paid in full
      paid: live.reduce((sum, o) => sum + (o.status === 'completed' ? o.total_amount : o.deposit_amount), 0),
      outstanding: live.filter(o => o.status !== 'completed').reduce((sum, o) => sum + o.remaining_balance, 0),
      ready: inPeriod.filter(o => o.status === 'ready_for_delivery').length,
      completed: inPeriod.filter(o => o.status === 'completed').length,
    }
  }, [inPeriod])

  const filtered = useMemo(() => inPeriod.filter(order => {
    const query = search.trim().toLowerCase()
    const searchable = [order.deposit_id, order.customer_name, order.phone, order.product_name, STATUS_LABELS[order.status]].join(' ').toLowerCase()
    if (query && !searchable.includes(query)) return false
    if (statusFilter === 'pending' && !['pending_deposit', 'waiting_final_payment'].includes(order.status)) return false
    if (statusFilter === 'ready' && order.status !== 'ready_for_delivery') return false
    if (statusFilter === 'completed' && order.status !== 'completed') return false
    if (statusFilter === 'cancelled' && order.status !== 'cancelled') return false
    return true
  }), [inPeriod, search, statusFilter])

  const formTotals = useMemo(() => computeAdvanceTotals({ subtotal: Number(form.totalAmount) || 0, deliveryCharge: Number(form.deliveryCharge) || 0, discount: Number(form.discount) || 0, gstRate: form.gstEnabled ? Number(form.gstRate) || 0 : 0 }), [form.totalAmount, form.deliveryCharge, form.discount, form.gstEnabled, form.gstRate])

  const create = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); setNotice('')
    const total = formTotals.total; const deposit = Number(form.depositAmount)
    if (Number(form.discount) > Number(form.totalAmount)) { setError('Discount cannot be more than the item amount.'); setSaving(false); return }
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(deposit) || deposit <= 0 || deposit >= total) { setError('Deposit must be greater than ₹0 and less than the total order amount.'); setSaving(false); return }
    if (form.paymentMethod === 'split' && Math.abs(splitTotal(splitInputToDetails(depositSplit)) - deposit) >= 0.01) { setError(`Split amounts must add up to the deposit of ${formatCurrency(deposit)}.`); setSaving(false); return }
    try {
      const created = await createAdvanceOrder({ ...form, splitDetails: form.paymentMethod === 'split' ? splitInputToDetails(depositSplit) : undefined, totalAmount: total, depositAmount: deposit, referenceNumber: form.reference_number, createdByName: role || 'Staff', breakdown: { subtotal: formTotals.subtotal, deliveryCharge: formTotals.deliveryCharge, discount: formTotals.discount, gstRate: formTotals.gstRate, cgst: formTotals.cgst, sgst: formTotals.sgst }, products: [{ name: form.productName, category: form.category, description: form.description, quantity: 1, base_price: formTotals.subtotal, line_total: formTotals.subtotal, unit: 'piece', unit_type: 'unit', source: 'advance_order' }] })
      setOrders(current => [created, ...current]); setForm(initialForm); setDepositSplit(emptySplitInput()); setCreateOpen(false); setNotice(`${created.deposit_id} created. Deposit is tracked separately and has not been added to revenue.`)

      // Redirect to WhatsApp with advance deposit receipt
      const advanceMsg = buildAdvanceDepositWhatsAppMessage({
        customerName: created.customer_name,
        depositId: created.deposit_id,
        productName: created.product_name,
        totalAmount: created.total_amount,
        depositAmount: created.deposit_amount,
        remainingBalance: created.remaining_balance,
        expectedDeliveryDate: created.expected_delivery_date,
        subtotal: formTotals.subtotal, deliveryCharge: formTotals.deliveryCharge, discount: formTotals.discount, cgst: formTotals.cgst, sgst: formTotals.sgst,
        paymentMethod: form.paymentMethod === 'split' ? formatPaymentLabel('split', splitInputToDetails(depositSplit)) : form.paymentMethod,
      })
      window.open(toWhatsAppUrl(created.phone, advanceMsg), '_blank', 'noopener,noreferrer')
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to create advance order') } finally { setSaving(false) }
  }

  const changeStatus = async (order: AdvanceOrder, status: AdvanceStatus) => {
    if (order.status === 'cancelled') {
      setError('A cancelled order cannot be modified.')
      return
    }
    if (order.status === 'completed' || order.invoice_number || order.completed_order_id) {
      setError('This order is already completed and has an official invoice.')
      return
    }
    if (status === 'completed') { setPaymentOrder(order); return }
    try { const updated = await updateAdvanceStatus(order.id, status); setOrders(rows => rows.map(row => row.id === order.id ? updated : row)); if (selected?.id === order.id) void openDetails(updated) } catch (err) { setError(err instanceof Error ? err.message : 'Unable to update status') }
  }

  const finalAmountFor = (order: AdvanceOrder) => order.remaining_balance

  const receivePayment = async (event: FormEvent) => {
    event.preventDefault(); if (!paymentOrder) return; setSaving(true); setError('')
    try {
      const finalAmount = paymentOrder.remaining_balance
      if (paymentForm.method === 'split' && Math.abs(splitTotal(splitInputToDetails(finalSplit)) - finalAmount) >= 0.01) {
        setError(`Split amounts must add up to the final amount of ${formatCurrency(finalAmount)}.`); setSaving(false); return
      }
      const remarksWithCoupon = paymentForm.remarks
      const result = await completeAdvanceOrder(
        paymentOrder.id, 
        paymentForm.method, 
        finalAmount,
        null,
        0,
        0,
        remarksWithCoupon,
        paymentForm.method === 'split' ? splitInputToDetails(finalSplit) : undefined
      )
      const completed: AdvanceOrder = { ...paymentOrder, status: 'completed', remaining_balance: finalAmount, completed_at: result.completed_at, completed_order_id: result.order_id, invoice_number: result.invoice_no, final_payment_method: paymentForm.method, split_details: result.split_details }
      setOrders(rows => rows.map(row => row.id === completed.id ? completed : row)); onOrderCompleted?.(completed); setPaymentOrder(null); setPaymentForm({ method: 'cash', remarks: '' }); setFinalSplit(emptySplitInput()); setNotice(`${result.invoice_no} generated once. The full ${formatCurrency(completed.total_amount)} is now recognized as revenue.`)

      // Show the bill; WhatsApp / print / view are buttons on it
      const payments = await paymentsFor(completed).catch(() => [])
      setFinalBill({
        order: completed,
        props: advanceDocumentProps(completed, payments),
        received: finalAmount,
        method: paymentForm.method === 'split' ? formatPaymentLabel('split', result.split_details) : paymentForm.method,
      })
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to complete payment') } finally { setSaving(false) }
  }

  const productRows = (order: AdvanceOrder) => order.products.length ? order.products : [{ name: order.product_name, quantity: 1, base_price: advanceBreakdown(order).subtotal, line_total: advanceBreakdown(order).subtotal, unit: 'piece', unit_type: 'unit' }]
  const paymentsFor = async (order: AdvanceOrder) => (await getAdvanceOrderHistory(order.id)).payments
  /** Advance receipt before the balance is paid, final invoice after — both in the shared invoice layout. */
  const printDocument = async (order: AdvanceOrder) => {
    try { setPrintProps(advanceDocumentProps(order, await paymentsFor(order))) }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to prepare the receipt') }
  }
  /** Receipt / invoice preview (Print, Download, Open Full Page) */
  const openPreview = async (order: AdvanceOrder) => {
    try { setPreview({ order, props: advanceDocumentProps(order, await paymentsFor(order)) }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to open the receipt') }
  }
  const downloadReceipt = async (order: AdvanceOrder) => {
    try {
      const props = advanceDocumentProps(order, await paymentsFor(order))
      const name = order.status === 'completed' ? `Invoice-${order.invoice_number || order.deposit_id}.pdf` : `Advance-Receipt-${order.deposit_id}.pdf`
      downloadFile(await invoicePdfFromProps(props, name))
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to create the PDF') }
  }

  const whatsappDepositReceipt = (order: AdvanceOrder) => {
    const message = buildAdvanceDepositWhatsAppMessage({
      customerName: order.customer_name,
      depositId: order.deposit_id,
      productName: order.product_name,
      totalAmount: order.total_amount,
      depositAmount: order.deposit_amount,
      remainingBalance: order.remaining_balance,
      expectedDeliveryDate: order.expected_delivery_date,
      subtotal: advanceBreakdown(order).subtotal, deliveryCharge: order.delivery_charge, discount: order.discount_amount, cgst: order.cgst_amount, sgst: order.sgst_amount,
    })
    window.open(toWhatsAppUrl(order.phone, message), '_blank', 'noopener,noreferrer')
  }

  const whatsappInvoice = async (order: AdvanceOrder) => {
    const invNum = order.invoice_number || order.deposit_id
    const b = advanceBreakdown(order)
    const props = advanceDocumentProps(order, await paymentsFor(order))
    const message = buildProfessionalWhatsAppMessage({
      customerName: order.customer_name,
      phone: order.phone,
      invoiceNumber: invNum,
      invoiceUrl: publicInvoiceUrl(invNum),
      invoiceDate: order.completed_at || undefined,
      items: (props.items || []).map((item) => {
        const qty = Number(item.qty ?? 1) || 1
        const rate = Number(item.price ?? 0) || 0
        const raw = item as unknown as Record<string, unknown>
        return {
          name: String(item.name || 'Item'),
          qty,
          unit: String(raw.unit || 'piece'),
          unitType: 'unit' as const,
          rate,
          lineTotal: Number(raw.line_total ?? rate * qty) || 0,
        }
      }),
      paymentMode: props.paymentMode,
      subtotal: b.subtotal,
      manualDiscountAmount: b.discount,
      shipping: b.deliveryCharge,
      gstAmount: b.gstTotal,
      total: order.total_amount,
    })
    window.open(toWhatsAppUrl(order.phone, message), '_blank', 'noopener,noreferrer')
  }

  const saveInternalNotes = async (order: AdvanceOrder) => {
    setSavingNotes(true); setError('')
    try {
      await updateAdvanceInternalNotes(order.id, internalNotes.reference, internalNotes.remarks)
      const updated = { ...order, reference_number: internalNotes.reference.trim(), remarks: internalNotes.remarks.trim() }
      setOrders(rows => rows.map(row => row.id === order.id ? updated : row))
      setSelected(current => current?.id === order.id ? updated : current)
      setNotice(`Internal notes saved for ${order.deposit_id}.`)
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save notes') } finally { setSavingNotes(false) }
  }

  const addEvent = async (order: AdvanceOrder, eventType: string, label: string) => {
    try { await addAdvanceEvent(order.id, eventType, label); await openDetails(order); setNotice(`${label} added to ${order.deposit_id}.`) } catch (err) { setError(err instanceof Error ? err.message : 'Unable to add timeline event') }
  }

  const cards = [
    { label: 'Pending Deposit Amount Received', value: formatCurrency(analytics.openDeposits), note: `${analytics.openCount} bills with pending deposits`, icon: <IndianRupee size={18} strokeWidth={2} />, tile: 'bg-emerald-50 text-emerald-700' },
    { label: 'Needed to Receive (Pending)', value: formatCurrency(analytics.outstanding), note: `${analytics.openBalanceCount} bills with balance due`, icon: <Wallet size={18} strokeWidth={2} />, tile: 'bg-amber-50 text-amber-700' },
    { label: 'Total Advance Orders Value', value: formatCurrency(analytics.orderValue), note: `${analytics.total - inPeriod.filter(o => o.status === 'cancelled').length} total advance orders`, icon: <FileText size={18} strokeWidth={2} />, tile: 'bg-fuchsia-50 text-fuchsia-700' },
    { label: 'Ready for Delivery', value: String(analytics.ready), note: 'Ready for customer pickup / delivery', icon: <Box size={18} strokeWidth={2} />, tile: 'bg-blue-50 text-blue-700' },
    { label: 'Pending Orders', value: String(analytics.pending), note: 'Awaiting balance or confirmation', icon: <Clock size={18} strokeWidth={2} />, tile: 'bg-red-50 text-red-600' },
  ]
  const periods: Array<[DateFilter, string]> = [['all', 'All Time'], ['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['year', 'This Year']]
  const iconBtn = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors cursor-pointer'

  return <div className="space-y-6">
    {finalBill && !preview && createPortal((() => {
      const { order, props, received, method } = finalBill
      const isGst = (props.cgstAmount || 0) + (props.sgstAmount || 0) > 0
      const chip = /^split/i.test(method) ? 'Split' : method === 'upi' || method === 'qr' ? 'QR / GPay' : method
      const btn = 'inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-3 text-[11px] font-black uppercase tracking-wider text-[#111111] hover:bg-gray-50'
      return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Bill generated">
          <div className="max-h-full w-full max-w-[680px] overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl sm:p-8">
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 pb-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2 className="text-[26px] font-black tracking-tight text-[#111111] sm:text-[28px]">Bill Generated</h2>
                  <span className="rounded-md bg-gray-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-[#111111]">{isGst ? 'GST' : 'Non-GST'}</span>
                </div>
                <p className="mt-1 font-mono text-xs font-bold text-primary">#{formatInvoiceNo(props.invoiceNo)}</p>
                <p className="mt-0.5 text-[11px] font-semibold text-gray-500">Advance order {order.deposit_id}</p>
              </div>
              <button type="button" onClick={() => setFinalBill(null)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-[#111111] px-4 text-[11px] font-black uppercase tracking-wider text-white hover:bg-black">
                <Plus size={16} /> New Sale
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-gray-200 p-5">
              <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-gray-400">Payment Receipt</p>
                <span className="rounded-md bg-gray-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-primary">{chip}</span>
              </div>
              <div className="flex items-center justify-between pt-4">
                <span className="text-sm font-semibold text-gray-600">Grand Total</span>
                <span className="text-2xl font-black tabular-nums text-[#111111]">{formatCurrency(order.total_amount)}</span>
              </div>
              <div className="flex items-center justify-between pt-3">
                <span className="text-sm font-semibold text-gray-600">Advance Paid Earlier</span>
                <span className="text-base font-black tabular-nums text-[#111111]">{formatCurrency(order.deposit_amount)}</span>
              </div>
              <div className="flex items-center justify-between pt-3">
                <span className="text-sm font-semibold text-gray-600">Amount Received</span>
                <span className="text-lg font-black tabular-nums text-[#111111]">{formatCurrency(received)}</span>
              </div>
              <div className="mt-4 flex items-center justify-between rounded-xl border border-gray-200 bg-gray-100 px-4 py-4">
                <span className="text-sm font-black text-primary">Balance Due</span>
                <span className="text-2xl font-black tabular-nums text-primary">{formatCurrency(0)}</span>
              </div>
              {/^split/i.test(method) && <p className="mt-3 text-xs font-semibold text-gray-500">{method}</p>}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <button type="button" onClick={() => setPrintProps(props)} className={btn}><Printer size={16} /> Print Receipt</button>
              <button type="button" onClick={() => setPreview({ order, props })} className={btn}><Eye size={16} /> View</button>
              <button type="button" onClick={() => whatsappInvoice(order)} className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-3 text-[11px] font-black uppercase tracking-wider text-white hover:bg-emerald-600">
                <MessageCircle size={16} /> WhatsApp Invoice
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-gray-200 p-5">
              <p className="border-b border-gray-100 pb-3 text-[11px] font-black uppercase tracking-[0.14em] text-gray-400">Items Sold</p>
              <div className="space-y-2.5 pt-3">
                {props.items.map((item, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 font-semibold text-[#111111]">{item.name} <span className="text-[11px] font-semibold text-gray-400">× {Number(item.quantity ?? item.qty ?? 1)}</span></span>
                    <span className="shrink-0 font-bold tabular-nums">{formatCurrency(Number(item.line_total ?? item.lineTotal ?? 0))}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )
    })(), document.body)}
    {preview && (() => {
      const headerBtn = 'inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-bold text-white hover:bg-white/20'
      const { order, props } = preview
      return (
        <InvoicePreviewModal
          invoice={props}
          fullPageUrl={order.status === 'completed' && order.invoice_number ? publicInvoiceUrl(order.invoice_number) : undefined}
          onClose={() => setPreview(null)}
          actions={
            <>
              <button type="button" onClick={() => setPrintProps(props)} className={headerBtn}>
                <Printer size={14} /> <span className="hidden sm:inline">Print</span>
              </button>
              <button type="button" onClick={() => void downloadReceipt(order)} className={headerBtn}>
                <Download size={14} /> <span className="hidden sm:inline">Download</span>
              </button>
            </>
          }
        />
      )
    })()}
    <PrintSettingsModal open={printProps !== null} onClose={() => setPrintProps(null)} onPrint={(settings) => { if (printProps) printBill(printProps, settings) }} />
    <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
      <div className="max-w-xl">
        <h2 className="text-[28px] font-black leading-tight tracking-tight text-[#111111]">Advance Orders</h2>
        <p className="mt-1 text-xs font-semibold text-[#111111]">Partial-payment holds — revenue is recognized only when the balance is collected.</p>
      </div>
      <div className="flex flex-col gap-3 xl:items-end">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap items-center gap-1 rounded-2xl border border-gray-200 bg-white p-1.5 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
            <span className="px-3 text-[10px] font-bold uppercase tracking-wider text-[#111111]">Period:</span>
            {periods.map(([value, text]) => (
              <button key={value} type="button" onClick={() => { setDateFilter(value); setDateFrom(''); setDateTo('') }}
                className={`rounded-xl px-4 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${dateFilter === value ? 'bg-primary text-primary-ink' : 'text-[#111111] hover:bg-gray-50'}`}>
                {text}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void load()} title="Refresh" aria-label="Refresh" className="flex h-10 w-12 items-center justify-center rounded-2xl border border-gray-200 bg-white text-gray-600 hover:text-[#111111]"><RefreshCw size={18} /></button>
        <div className="inline-flex flex-wrap items-center gap-4 rounded-2xl border border-gray-200 bg-white px-4 py-2.5 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
          <label className="flex items-center gap-2"><span className="text-[10px] font-bold uppercase tracking-wider text-[#111111]">From:</span>
            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setDateFilter('custom') }} className="bg-transparent text-sm font-black text-[#111111] outline-none" /></label>
          <label className="flex items-center gap-2"><span className="text-[10px] font-bold uppercase tracking-wider text-[#111111]">To:</span>
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setDateFilter('custom') }} className="bg-transparent text-sm font-black text-[#111111] outline-none" /></label>
        </div>
        </div>
      </div>
    </div>

    {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}
    {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</div>}

    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {cards.map(card => (
        <div key={card.label} className="flex flex-col rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <p className="min-h-[2.5em] text-[11px] font-bold uppercase leading-snug tracking-wider text-gray-600">{card.label}</p>
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${card.tile}`}>{card.icon}</span>
          </div>
          <p className="mt-4 text-[26px] font-black leading-none text-[#111111]">{card.value}</p>
          <p className="mt-4 border-t border-gray-100 pt-3 text-xs font-medium text-gray-500">{card.note}</p>
        </div>
      ))}
    </div>

    <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm lg:flex-row lg:items-center">
      <label className="relative flex-1">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#111111]" size={19} strokeWidth={1.75} />
        <input className="h-10 w-full rounded-xl border border-gray-200 pl-12 pr-4 text-sm font-semibold text-[#111111] placeholder:text-gray-500 focus:border-primary focus:outline-none" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by ID, customer, phone, product or status" />
      </label>
      <div className="flex flex-wrap gap-2">
        {(['all', 'pending', 'ready', 'completed', 'cancelled'] as StatusFilter[]).map(value => (
          <button key={value} type="button" onClick={() => setStatusFilter(value)}
            className={`h-9 rounded-xl px-4 text-[10px] font-bold uppercase tracking-wider transition-colors ${statusFilter === value ? 'bg-primary text-primary-ink' : 'bg-gray-100 text-[#111111] hover:bg-gray-200'}`}>
            {value}
          </button>
        ))}
      </div>
    </div>

    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-left">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              {['Deposit ID', 'Customer', 'Product', 'Total / Paid / Balance', 'Delivery', 'Status'].map(h => (
                <th key={h} className="whitespace-nowrap px-4 py-3.5 text-[10px] font-black uppercase tracking-wider text-primary">{h}</th>
              ))}
              <th className="whitespace-nowrap px-4 py-3.5 text-right text-[10px] font-black uppercase tracking-wider text-primary">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-5 py-14 text-center text-[14px] text-gray-500">Loading advance orders...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-14 text-center text-[14px] text-gray-500">No advance orders match these filters.</td></tr>
            ) : (
              filtered.map(order => {
                const finalised = order.status === 'completed' || order.status === 'cancelled' || !!order.invoice_number || !!order.completed_order_id
                const firstProduct = productRows(order)[0]
                const ready = order.status === 'ready_for_delivery'
                const pillText = order.status === 'completed' ? 'Completed' : order.status === 'cancelled' ? 'Cancelled' : ready ? 'Ready' : 'Pending'
                const pillTone = order.status === 'completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : order.status === 'cancelled' ? 'border-red-200 bg-red-50 text-red-700'
                  : ready ? 'border-blue-200 bg-blue-50 text-blue-700'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
                return (
                <tr key={order.id} className="border-b border-gray-100 last:border-0">
                  <td className="whitespace-nowrap px-4 py-4 align-middle">
                    <p className="font-mono text-[12.5px] font-bold text-[#111111]">{order.deposit_id}</p>
                    <p className="mt-0.5 text-[10px] font-bold text-primary">{new Date(order.created_at).toLocaleDateString('en-US')}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 align-middle">
                    <p className="text-[14px] font-black text-[#111111]">{order.customer_name}</p>
                    <p className="text-[11px] font-medium text-gray-600">{order.phone}</p>
                  </td>
                  <td className="max-w-[220px] px-4 py-4 align-middle">
                    <p className="truncate text-[12.5px] font-bold text-[#111111]">{/^\s*\d+\s*×/.test(order.product_name) ? order.product_name : `${Number(firstProduct?.quantity || 1)}× ${order.product_name}`}</p>
                    {order.category && <p className="truncate text-[11px] text-gray-500">{order.category}</p>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 align-middle text-[12px] font-bold leading-snug">
                    <p className="text-[#111111]">Total: {formatCurrency(order.total_amount)}</p>
                    <p className="text-emerald-600">Paid: {formatCurrency(order.status === 'completed' ? order.total_amount : order.deposit_amount)}</p>
                    <p className={order.status === 'completed' ? 'text-gray-500' : 'text-[#DC2626]'}>Balance: {formatCurrency(order.status === 'completed' ? 0 : order.remaining_balance)}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 align-middle text-[12px] font-bold text-primary">
                    {order.expected_delivery_date ? new Date(`${order.expected_delivery_date}T00:00:00`).toLocaleDateString('en-US') : '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 align-middle">
                    <span className={`inline-block rounded-md border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${pillTone}`}>{pillText}</span>
                    {!finalised && (
                      <button
                        type="button"
                        onClick={() => void changeStatus(order, ready ? 'waiting_final_payment' : 'ready_for_delivery')}
                        className="mt-1 block text-[9.5px] font-black uppercase tracking-wider text-blue-600 hover:underline"
                      >
                        {ready ? 'Mark as pending' : 'Mark as ready'}
                      </button>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 align-middle">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" onClick={() => order.status === 'completed' ? whatsappInvoice(order) : whatsappDepositReceipt(order)}
                        className={`${iconBtn} bg-emerald-50 text-emerald-600 hover:bg-emerald-100`}
                        title={order.status === 'completed' ? 'Share Final Invoice via WhatsApp' : 'Share Advance Receipt via WhatsApp'} aria-label="Share on WhatsApp">
                        <MessageCircle size={17} strokeWidth={2} />
                      </button>
                      <button type="button" onClick={() => void openPreview(order)}
                        className={`${iconBtn} bg-primary-50 text-primary hover:bg-primary-100`}
                        title={order.status === 'completed' ? 'View Invoice' : 'View Advance Receipt'} aria-label={order.status === 'completed' ? 'View invoice' : 'View advance receipt'}>
                        <FileText size={17} strokeWidth={2} />
                      </button>
                      <button type="button" onClick={() => void openDetails(order)}
                        className={`${iconBtn} bg-gray-100 text-[#111111] hover:bg-gray-200`} title="View Details" aria-label="View details">
                        <Eye size={17} strokeWidth={2} />
                      </button>
                      {!finalised && (
                        <button type="button" onClick={() => setPaymentOrder(order)}
                          className={`${iconBtn} bg-emerald-50 text-emerald-600 hover:bg-emerald-100`} title="Receive Remaining Balance" aria-label="Receive remaining balance">
                          <IndianRupee size={17} strokeWidth={2} />
                        </button>
                      )}
                      {!finalised && (
                        <button type="button" onClick={() => { if (window.confirm(`Cancel advance order ${order.deposit_id}?`)) void changeStatus(order, 'cancelled') }}
                          className={`${iconBtn} bg-amber-50 text-amber-600 hover:bg-amber-100`} title="Cancel Order" aria-label="Cancel order">
                          <X size={17} strokeWidth={2} />
                        </button>
                      )}
                      {role !== 'staff' && (
                        <button type="button" onClick={() => void handleDeleteOrder(order.id, order.customer_name)}
                          className={`${iconBtn} bg-red-50 text-[#DC2626] hover:bg-red-100`} title="Delete Order" aria-label="Delete order">
                          <Trash2 size={17} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )})
            )}
          </tbody>
        </table>
      </div>
    </div>

    {createOpen && createPortal(
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4 animate-in fade-in duration-150">
        <form onSubmit={create} className="h-[100dvh] max-h-[100dvh] w-full max-w-4xl overflow-y-auto overscroll-contain rounded-none bg-white p-4 pb-0 shadow-2xl sm:h-auto sm:max-h-full sm:rounded-3xl sm:border border-[#F3F4F6] sm:p-6 sm:pb-0">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h3 className="text-xl font-black text-[#111111]">Create Advance Order</h3>
              <p className="text-xs text-amber-700">Creates an advance receipt only - no revenue or final invoice.</p>
            </div>
            <button type="button" onClick={() => setCreateOpen(false)} className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-700 transition cursor-pointer">
              <X size={18} />
            </button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Customer Name *" htmlFor="adv-customer-name"><input id="adv-customer-name" name="customerName" autoComplete="name" required className={inputClass} value={form.customerName} onChange={e=>setForm({...form,customerName:e.target.value})}/></Field>
            <Field label="Phone Number *" htmlFor="adv-phone-number"><input id="adv-phone-number" name="phone" autoComplete="tel" required className={inputClass} value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></Field>
            <Field label="Address" htmlFor="adv-address"><textarea id="adv-address" name="address" autoComplete="street-address" className={inputClass} value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></Field>
            <Field label="Product Name *" htmlFor="adv-product-name"><input id="adv-product-name" name="productName" required list="advance-products" className={inputClass} value={form.productName} onChange={e=>{const product=products.find(p=>p.name===e.target.value);setForm({...form,productName:e.target.value,category:product?.category||form.category})}}/><datalist id="advance-products">{products.map(p=><option key={p.id} value={p.name}/>)}</datalist></Field>
            <Field label="Category" htmlFor="adv-category"><input id="adv-category" name="category" className={inputClass} value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/></Field>
            <Field label="Description" htmlFor="adv-description"><textarea id="adv-description" name="description" className={inputClass} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></Field>
            <Field label="Item Amount (Subtotal) *" htmlFor="adv-total-amount"><input id="adv-total-amount" name="totalAmount" required min="0.01" step="0.01" type="number" className={inputClass} value={form.totalAmount} onChange={e=>setForm({...form,totalAmount:e.target.value})}/></Field>
            <Field label="Delivery Charge" htmlFor="adv-delivery-charge"><input id="adv-delivery-charge" name="deliveryCharge" min="0" step="0.01" type="number" placeholder="0 = Free" className={inputClass} value={form.deliveryCharge} onChange={e=>setForm({...form,deliveryCharge:e.target.value})}/></Field>
            <Field label="Discount" htmlFor="adv-discount"><input id="adv-discount" name="discount" min="0" step="0.01" type="number" placeholder="0" className={inputClass} value={form.discount} onChange={e=>setForm({...form,discount:e.target.value})}/></Field>
            <Field label="GST (CGST + SGST)" htmlFor="adv-gst-enabled"><div className="flex items-center gap-3"><label className="flex items-center gap-2 text-sm font-bold text-[#111111]"><input id="adv-gst-enabled" name="gstEnabled" type="checkbox" checked={form.gstEnabled} onChange={e=>setForm({...form,gstEnabled:e.target.checked})}/>Add GST</label>{form.gstEnabled && <div className="flex items-center gap-1.5"><input aria-label="GST rate %" name="gstRate" min="0" max="100" step="0.01" type="number" className={`${inputClass} w-24`} value={form.gstRate} onChange={e=>setForm({...form,gstRate:e.target.value})}/><span className="text-sm font-bold text-gray-600">%</span></div>}</div></Field>
            <div className="md:col-span-2 rounded-2xl border border-primary-soft/40 bg-[#FAFAFA] p-4 text-sm">
              <div className="flex justify-between py-0.5"><span className="text-gray-600">Subtotal</span><b>{formatCurrency(formTotals.subtotal)}</b></div>
              <div className="flex justify-between py-0.5"><span className="text-gray-600">Delivery Charges</span><b>{formTotals.deliveryCharge > 0 ? formatCurrency(formTotals.deliveryCharge) : 'Free (₹0)'}</b></div>
              {formTotals.discount > 0 && <div className="flex justify-between py-0.5"><span className="text-gray-600">Discount</span><b className="text-red-600">-{formatCurrency(formTotals.discount)}</b></div>}
              {formTotals.gstTotal > 0 && <><div className="flex justify-between py-0.5"><span className="text-gray-600">CGST ({+(formTotals.gstRate / 2).toFixed(2)}%)</span><b>{formatCurrency(formTotals.cgst)}</b></div><div className="flex justify-between py-0.5"><span className="text-gray-600">SGST ({+(formTotals.gstRate / 2).toFixed(2)}%)</span><b>{formatCurrency(formTotals.sgst)}</b></div></>}
              <div className="mt-1.5 flex justify-between border-t border-primary-soft/40 pt-2 text-base"><span className="font-black text-primary-hover">TOTAL AMOUNT</span><b className="font-black text-[#111111]">{formatCurrency(formTotals.total)}</b></div>
            </div>
            <Field label="Deposit Amount Received *" htmlFor="adv-deposit-amount"><input id="adv-deposit-amount" name="depositAmount" required min="0" step="0.01" type="number" className={inputClass} value={form.depositAmount} onChange={e=>setForm({...form,depositAmount:e.target.value})}/></Field>
            <Field label="Remaining Balance (automatic)"><div className="rounded-xl bg-[#F9FAFB] px-4 py-3 font-black text-[#111111] border border-[#F3F4F6]">{formatCurrency(Math.max(0, formTotals.total-Number(form.depositAmount||0)))}</div></Field>
            <Field label="Deposit Payment Method" htmlFor="adv-payment-method"><select id="adv-payment-method" name="paymentMethod" className={inputClass} value={form.paymentMethod} onChange={e=>setForm({...form,paymentMethod:e.target.value as AdvancePaymentMethod})}><option value="cash">Cash</option><option value="upi">QR</option><option value="card">Card</option><option value="split">Split (Cash / QR / Card)</option></select></Field>
            {form.paymentMethod === 'split' && (<div className="md:col-span-2"><SplitPaymentInputs idPrefix="adv-deposit-split" total={Number(form.depositAmount) || 0} value={depositSplit} onChange={setDepositSplit} /></div>)}
            <Field label="Expected Delivery Date *" htmlFor="adv-delivery-date"><input id="adv-delivery-date" name="deliveryDate" required type="date" className={inputClass} value={form.expectedDeliveryDate} onChange={e=>setForm({...form,expectedDeliveryDate:e.target.value})}/></Field>
            <Field label="Order Status" htmlFor="adv-status"><select id="adv-status" name="orderStatus" disabled className={inputClass} value="pending_deposit"><option value="pending_deposit">Pending Deposit</option></select></Field>
            <div className="md:col-span-2"><Field label="Reference Number (Internal)" htmlFor="adv-reference-number"><input id="adv-reference-number" name="referenceNumber" className={inputClass} value={form.reference_number} onChange={e=>setForm({...form,reference_number:e.target.value})} placeholder="e.g. PO-001, booking ref (optional)"/></Field></div>
            <div className="md:col-span-2"><Field label="Remarks (Internal)" htmlFor="adv-remarks"><textarea id="adv-remarks" name="remarks" className={inputClass} value={form.remarks} onChange={e=>setForm({...form,remarks:e.target.value})} placeholder="e.g. special instructions, colour, size notes"/></Field></div>
          </div>
          <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex justify-end gap-3 border-t border-gray-100 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 sm:pb-6">
            <button type="button" onClick={()=>setCreateOpen(false)} className="rounded-xl border border-gray-200 px-5 py-2.5 font-bold cursor-pointer hover:bg-gray-50 transition text-gray-700">Cancel</button>
            <button disabled={saving} className="rounded-xl bg-primary hover:bg-primary-hover px-5 py-2.5 font-black text-primary-100 border border-primary-soft/50 shadow-md disabled:opacity-50 cursor-pointer transition">{saving?'Creating...':'Create & Save Advance Receipt'}</button>
          </div>
        </form>
      </div>,
      document.body
    )}

    {paymentOrder && createPortal(
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4 animate-in fade-in duration-150">
        <form onSubmit={receivePayment} className="h-[100dvh] max-h-[100dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-none bg-white p-4 pb-0 shadow-2xl sm:h-auto sm:max-h-full sm:rounded-3xl sm:border border-[#F3F4F6] sm:p-6 sm:pb-0">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-wider text-emerald-600 font-mono">{paymentOrder.deposit_id}</p>
              <h3 className="text-xl font-black text-[#111111]">Receive Remaining Payment</h3>
            </div>
            <button type="button" onClick={()=>setPaymentOrder(null)} className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-700 transition cursor-pointer">
              <X size={16}/>
            </button>
          </div>
          <div className="mb-6 rounded-2xl bg-emerald-50 py-5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600">Remaining Amount</p>
            <p className="mt-1 text-4xl font-black text-emerald-800">{formatCurrency(paymentOrder.remaining_balance)}</p>
          </div>
          <div className="space-y-4">
            <Field label="Payment Method">
              <select className={inputClass} value={paymentForm.method} onChange={e=>setPaymentForm({...paymentForm,method:e.target.value as AdvancePaymentMethod})}>
                <option value="cash">Cash</option>
                <option value="upi">QR</option>
                <option value="card">Card</option>
                <option value="split">Split (Cash / QR / Card)</option>
              </select>
            </Field>
            {paymentForm.method === 'split' && (
              <SplitPaymentInputs idPrefix="adv-final-split" total={finalAmountFor(paymentOrder)} value={finalSplit} onChange={setFinalSplit} />
            )}
            <Field label="Payment Notes">
              <textarea className={inputClass} value={paymentForm.remarks} onChange={e=>setPaymentForm({...paymentForm,remarks:e.target.value})} placeholder="Notes about this payment (optional)"/>
            </Field>
            <p className="mt-2 rounded-xl bg-amber-50 p-3 text-[11px] font-semibold text-amber-800">Confirmation marks the order Completed, creates one official invoice, and recognizes the full {formatCurrency(paymentOrder.total_amount)} as revenue.</p>
          </div>
          <div className="sticky bottom-0 z-10 -mx-4 mt-5 border-t border-gray-100 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 sm:pb-6">
            <button disabled={saving} className="w-full rounded-xl bg-emerald-600 py-3.5 font-black text-white shadow-lg shadow-emerald-600/30 transition-transform active:scale-95 disabled:opacity-50 cursor-pointer hover:bg-emerald-700">
              {saving?'Processing...':'Confirm Final Payment'}
            </button>
          </div>
        </form>
      </div>,
      document.body
    )}

    {selected && createPortal(
      <div className="fixed inset-0 z-[9999] flex justify-end bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
        {/* Backdrop click dismiss */}
        <div className="absolute inset-0" onClick={() => setSelected(null)} />

        {/* Drawer Panel covering full view height */}
        <div className="relative z-10 h-full w-full max-w-xl bg-white shadow-2xl flex flex-col border-l border-[#F3F4F6] animate-in slide-in-from-right duration-200">
          {/* Sticky Drawer Header */}
          <div className="shrink-0 px-6 py-4 border-b border-primary-soft/30 bg-primary text-white flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-primary-hover border border-primary-soft/50 flex items-center justify-center text-primary-100 shrink-0">
                <FileText size={18} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black text-primary-hover tracking-wider font-mono">{selected.deposit_id}</span>
                  <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${STATUS_STYLES[selected.status]}`}>
                    {STATUS_LABELS[selected.status]}
                  </span>
                </div>
                <h3 className="text-base font-black text-white tracking-wide">Order Details</h3>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors cursor-pointer shrink-0"
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          </div>

          {/* Scrollable Drawer Body */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6 space-y-6">
            <div className="grid grid-cols-2 gap-3">
              {[
                ['Customer', selected.customer_name],
                ['Phone', formatPhoneDisplay(selected.phone)],
                ['Address', selected.address || '-'],
                ['Product', selected.product_name],
                ['Category', selected.category || '-'],
                ['Delivery Date', new Date(`${selected.expected_delivery_date}T00:00:00`).toLocaleDateString('en-IN')],
                ['Created Date', new Date(selected.created_at).toLocaleDateString('en-IN')],
                ['Created Time', new Date(selected.created_at).toLocaleTimeString('en-IN')],
                ['Created By', selected.created_by_name || '-'],
                ['Current Status', STATUS_LABELS[selected.status]],
                ['Invoice Number', selected.invoice_number || 'Not generated'],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-slate-50 p-3 border border-slate-200">
                  <p className="text-[10px] font-black uppercase text-gray-500">{k}</p>
                  <p className="mt-1 break-words text-sm font-bold text-gray-900">{v}</p>
                </div>
              ))}
            </div>

            {/* Shop-only notes: never printed on receipts / invoices or sent on WhatsApp */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h4 className="text-xs font-black uppercase tracking-wide text-[#111111]">Internal Notes</h4>
                <span className="text-[10px] font-bold text-gray-500">Not shown to the customer</span>
              </div>
              <div className="space-y-3">
                <Field label="Reference Number" htmlFor="adv-internal-reference">
                  <input id="adv-internal-reference" className={inputClass} value={internalNotes.reference} maxLength={60} placeholder="e.g. REF-1002"
                    onChange={e => setInternalNotes(n => ({ ...n, reference: e.target.value }))} />
                </Field>
                <Field label="Remarks" htmlFor="adv-internal-remarks">
                  <textarea id="adv-internal-remarks" className={inputClass} rows={2} value={internalNotes.remarks} maxLength={500} placeholder="Shop notes only"
                    onChange={e => setInternalNotes(n => ({ ...n, remarks: e.target.value }))} />
                </Field>
                <div className="flex justify-end">
                  <button type="button" disabled={savingNotes || (internalNotes.reference === (selected.reference_number || '') && internalNotes.remarks === (selected.remarks || ''))}
                    onClick={() => void saveInternalNotes(selected)}
                    className="rounded-xl bg-primary px-4 py-2 text-xs font-black text-primary-100 hover:bg-primary-hover disabled:opacity-40 cursor-pointer">
                    {savingNotes ? 'Saving…' : 'Save Notes'}
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border-2 border-primary-soft/50 bg-[#FAFAFA] p-4">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-xs font-black uppercase tracking-wide text-[#111111]">Financial Breakdown &amp; Balance</h4>
                <span className={`rounded border px-2 py-0.5 text-[10px] font-black uppercase ${selected.status === 'completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>{selected.status === 'completed' ? 'Fully Settled' : 'Balance Pending'}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {advanceBreakdownRows(selected).map(row => (
                  <div key={row.label} className={`rounded-xl border p-2.5 ${row.kind === 'total' ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
                    <p className={`text-[10px] font-black uppercase ${row.kind === 'total' ? 'text-primary-hover' : 'text-gray-500'}`}>{row.label}</p>
                    <p className="mt-1 text-sm font-black text-gray-900">{row.kind === 'free' ? 'Free (₹0)' : `${row.kind === 'minus' ? '-' : ''}${formatCurrency(row.value)}`}</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-1.5 rounded-xl border border-amber-200 bg-white p-3 text-sm">
                {paymentLines(selected, payments).map(line => (
                  <div key={`${line.label}-${line.sub ? 's' : 'm'}`} className={`flex justify-between ${line.sub ? 'pl-4 text-xs text-gray-500' : line.accent ? 'border-t border-amber-100 pt-1.5 font-black text-emerald-700' : 'font-bold text-gray-800'}`}>
                    <span>{line.label}</span><span>{formatCurrency(line.value)}</span>
                  </div>
                ))}
              </div>
            </div>


            {selected.description && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5">
                <p className="text-[10px] font-black uppercase text-gray-500">Description</p>
                <p className="mt-1 text-sm text-gray-800">{selected.description}</p>
              </div>
            )}

            <div>
              <h4 className="text-sm font-black text-gray-900">Quick Timeline Updates</h4>
              <div className="mt-2 flex flex-wrap gap-2">
                {[
                  ['order_confirmed', 'Order Confirmed'],
                  ['order_packed', 'Order Packed'],
                  ['ready_for_delivery', 'Ready for Delivery'],
                  ['customer_contacted', 'Customer Contacted'],
                  ['delivered', 'Delivered'],
                ].map(([type, label]) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => void addEvent(selected, type, label)}
                    className="rounded-lg border border-gray-200 bg-[#F9FAFB] hover:bg-gray-100 px-3 py-2 text-xs font-black text-[#111111] transition cursor-pointer"
                  >
                    + {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-black text-gray-900">Payment History</h4>
              <div className="mt-2 space-y-2">
                {payments.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No payments recorded yet.</p>
                ) : (
                  payments.map((payment) => (
                    <div key={payment.id} className="flex justify-between items-center rounded-xl bg-emerald-50 border border-emerald-100 p-3 text-sm">
                      <span className="font-bold capitalize text-emerald-900">{payment.payment_type} — {formatPaymentLabel(payment.payment_method, payment.split_details)}</span>
                      <span className="font-black text-emerald-800">{formatCurrency(Number(payment.amount))}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-black text-gray-900">Order Timeline</h4>
              <div className="mt-3 border-l-2 border-gray-200 pl-4 space-y-4">
                {timeline.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No timeline events recorded.</p>
                ) : (
                  timeline.map((event) => (
                    <div key={event.id} className="relative pb-2 before:absolute before:-left-[21px] before:top-1.5 before:h-2.5 before:w-2.5 before:rounded-full before:bg-primary">
                      <p className="text-sm font-black text-gray-900">{event.label}</p>
                      <p className="text-xs text-gray-500">{new Date(event.created_at).toLocaleString('en-IN')}</p>
                      {event.remarks && <p className="mt-1 text-xs text-gray-600 bg-white/70 p-2 rounded-lg border border-gray-100">{event.remarks}</p>}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Sticky Drawer Footer */}
          <div className="shrink-0 px-6 py-4 border-t border-gray-200 bg-slate-50 flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void printDocument(selected)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 bg-white text-xs font-bold text-gray-700 hover:bg-gray-100 cursor-pointer transition shadow-xs"
                title={selected.status === 'completed' ? 'Print Final Receipt' : 'Print Advance Receipt'}
              >
                <Printer size={14} /> Print
              </button>
              <button
                type="button"
                onClick={() => void downloadReceipt(selected)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 bg-white text-xs font-bold text-gray-700 hover:bg-gray-100 cursor-pointer transition shadow-xs"
                title={selected.status === 'completed' ? 'Download PDF Invoice' : 'Download PDF Receipt'}
              >
                <Download size={14} /> PDF
              </button>
              <button
                type="button"
                onClick={() => selected.status === 'completed' ? whatsappInvoice(selected) : whatsappDepositReceipt(selected)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold hover:bg-emerald-100 cursor-pointer transition shadow-xs"
                title="Share via WhatsApp"
              >
                <MessageCircle size={14} /> WhatsApp
              </button>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="px-5 py-2 rounded-xl bg-primary hover:bg-primary-hover text-primary-100 text-xs font-black cursor-pointer transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>,
      document.body
    )}
  </div>
}
