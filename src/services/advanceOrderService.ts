import { parseSplit, splitTotal, type SplitDetails } from '../lib/payments'
import { db, isDatabaseConfigured } from '../lib/db'

export type AdvanceStatus = 'pending_deposit' | 'ready_for_delivery' | 'waiting_final_payment' | 'completed' | 'cancelled'
export type AdvancePaymentMethod = 'cash' | 'upi' | 'card' | 'split'

export type AdvanceOrder = {
  id: string
  deposit_id: string
  customer_name: string
  phone: string
  address: string
  product_name: string
  products: Array<Record<string, unknown>>
  category: string
  description: string
  /** Grand total (items + delivery + GST - discount). Deposit / balance are tracked against this. */
  total_amount: number
  /** Item value before delivery, GST and discount. 0 on orders created before the breakdown existed. */
  subtotal_amount?: number
  delivery_charge?: number
  discount_amount?: number
  gst_rate?: number
  cgst_amount?: number
  sgst_amount?: number
  deposit_amount: number
  remaining_balance: number
  expected_delivery_date: string
  status: AdvanceStatus
  remarks: string
  reference_number: string
  created_by_name: string
  created_at: string
  updated_at: string
  completed_at: string | null
  completed_order_id: string | null
  invoice_number: string | null
  final_payment_method: string | null
  /** Full cash / QR / card amounts collected for this order (deposit + final payment). */
  split_details?: SplitDetails
}

export type AdvanceTimeline = { id: number; advance_order_id: string; event_type: string; label: string; remarks: string; created_at: string }
export type AdvancePayment = { id: string; advance_order_id: string; payment_type: 'deposit' | 'remaining'; amount: number; payment_method: string; split_details?: unknown; remarks: string; received_at: string }

const STORAGE_ORDERS_KEY = 'universal_look_advance_orders_v1'
const STORAGE_TIMELINE_KEY = 'universal_look_advance_timeline_v1'
const STORAGE_PAYMENTS_KEY = 'universal_look_advance_payments_v1'

const loadLocalOrders = (): AdvanceOrder[] => {
  try {
    const raw = localStorage.getItem(STORAGE_ORDERS_KEY)
    return raw ? (JSON.parse(raw) as AdvanceOrder[]) : []
  } catch {
    return []
  }
}

const saveLocalOrders = (orders: AdvanceOrder[]) => {
  try {
    localStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(orders))
  } catch { /* ignore */ }
}

const loadLocalTimeline = (): AdvanceTimeline[] => {
  try {
    const raw = localStorage.getItem(STORAGE_TIMELINE_KEY)
    return raw ? (JSON.parse(raw) as AdvanceTimeline[]) : []
  } catch {
    return []
  }
}

const saveLocalTimeline = (timeline: AdvanceTimeline[]) => {
  try {
    localStorage.setItem(STORAGE_TIMELINE_KEY, JSON.stringify(timeline))
  } catch { /* ignore */ }
}

const loadLocalPayments = (): AdvancePayment[] => {
  try {
    const raw = localStorage.getItem(STORAGE_PAYMENTS_KEY)
    return raw ? (JSON.parse(raw) as AdvancePayment[]) : []
  } catch {
    return []
  }
}

const saveLocalPayments = (payments: AdvancePayment[]) => {
  try {
    localStorage.setItem(STORAGE_PAYMENTS_KEY, JSON.stringify(payments))
  } catch { /* ignore */ }
}

const normalizeOrder = (row: Record<string, unknown>): AdvanceOrder => ({
  ...row,
  id: String(row.id || ''),
  deposit_id: String(row.deposit_id || ''),
  customer_name: String(row.customer_name || ''),
  phone: String(row.phone || ''),
  address: String(row.address || ''),
  product_name: String(row.product_name || ''),
  products: Array.isArray(row.products) ? (row.products as Array<Record<string, unknown>>) : [],
  category: String(row.category || ''),
  description: String(row.description || ''),
  total_amount: Number(row.total_amount || 0),
  subtotal_amount: Number(row.subtotal_amount || 0),
  delivery_charge: Number(row.delivery_charge || 0),
  discount_amount: Number(row.discount_amount || 0),
  gst_rate: Number(row.gst_rate || 0),
  cgst_amount: Number(row.cgst_amount || 0),
  sgst_amount: Number(row.sgst_amount || 0),
  deposit_amount: Number(row.deposit_amount || 0),
  remaining_balance: Number(row.remaining_balance ?? (Number(row.total_amount || 0) - Number(row.deposit_amount || 0))),
  expected_delivery_date: String(row.expected_delivery_date || ''),
  status: String(row.status || 'pending_deposit') as AdvanceStatus,
  remarks: String(row.remarks || ''),
  reference_number: String(row.reference_number || ''),
  created_by_name: String(row.created_by_name || ''),
  created_at: String(row.created_at || new Date().toISOString()),
  updated_at: String(row.updated_at || new Date().toISOString()),
  completed_at: row.completed_at ? String(row.completed_at) : null,
  completed_order_id: row.completed_order_id ? String(row.completed_order_id) : null,
  invoice_number: row.invoice_number ? String(row.invoice_number) : null,
  final_payment_method: row.final_payment_method ? String(row.final_payment_method) : null,
})

const breakdownColumns = (b: NonNullable<Parameters<typeof createAdvanceOrder>[0]['breakdown']>) => ({
  subtotal_amount: b.subtotal, delivery_charge: b.deliveryCharge, discount_amount: b.discount, gst_rate: b.gstRate, cgst_amount: b.cgst, sgst_amount: b.sgst,
})

/** Offline fallback: sequential 00000001, 00000002... kept per browser (the database sequence is used when online). */
const nextLocalInvoiceSeq = (): string => {
  let next = 1
  try {
    next = (Number(localStorage.getItem('universal_look_invoice_seq_v1')) || 0) + 1
    localStorage.setItem('universal_look_invoice_seq_v1', String(next))
  } catch { /* ignore */ }
  return String(next).padStart(8, '0')
}

const rpcRow = (data: unknown) => (Array.isArray(data) ? data[0] : data) as Record<string, unknown>

export async function deleteAdvanceOrder(orderId: string): Promise<void> {
  if (isDatabaseConfigured) {
    const { error } = await db.from('advance_orders').delete().eq('id', orderId)
    if (error) throw new Error(error.message)
  }
  
  // Clean up local storage
  const localOrders = loadLocalOrders().filter(o => o.id !== orderId)
  saveLocalOrders(localOrders)
  
  const localTimeline = loadLocalTimeline().filter(t => t.advance_order_id !== orderId)
  saveLocalTimeline(localTimeline)
  
  const localPayments = loadLocalPayments().filter(p => p.advance_order_id !== orderId)
  saveLocalPayments(localPayments)
}

export async function listAdvanceOrders(): Promise<AdvanceOrder[]> {
  const local = loadLocalOrders()
  if (isDatabaseConfigured) {
    try {
      const { data, error } = await db.from('advance_orders').select('*').order('created_at', { ascending: false })
      if (error) {
        console.error('[listAdvanceOrders] Supabase error:', error.message)
      } else if (Array.isArray(data)) {
        // The database is the source of truth; the device copy is only an offline backup,
        // so orders deleted on the server never come back from it
        const remote = data.map(row => normalizeOrder(row as Record<string, unknown>))
        saveLocalOrders(remote)
        return remote
      }
    } catch (err) { console.error('[listAdvanceOrders] Exception:', err) }
  }
  return local
}

export async function getAdvanceOrderHistory(orderId: string) {
  const localTimeline = loadLocalTimeline().filter(t => t.advance_order_id === orderId)
  const localPayments = loadLocalPayments().filter(p => p.advance_order_id === orderId)

  if (isDatabaseConfigured) {
    try {
      const [tRes, pRes] = await Promise.all([
        db.from('advance_order_timeline').select('*').eq('advance_order_id', orderId).order('created_at'),
        db.from('advance_order_payments').select('*').eq('advance_order_id', orderId).order('received_at'),
      ])
      const timeline = (tRes.data && tRes.data.length > 0) ? (tRes.data as AdvanceTimeline[]) : localTimeline
      const payments = (pRes.data && pRes.data.length > 0) ? (pRes.data as AdvancePayment[]) : localPayments
      return { timeline, payments }
    } catch { /* fallback */ }
  }
  return { timeline: localTimeline, payments: localPayments }
}

export async function createAdvanceOrder(input: {
  customerName: string; phone: string; address: string; productName: string; category: string; description: string
  totalAmount: number; depositAmount: number; expectedDeliveryDate: string; remarks: string; referenceNumber?: string
  paymentMethod: AdvancePaymentMethod; createdByName: string; products?: Array<Record<string, unknown>>
  splitDetails?: SplitDetails
  /** Price breakdown; totalAmount must equal subtotal + delivery + GST - discount. */
  breakdown?: { subtotal: number; deliveryCharge: number; discount: number; gstRate: number; cgst: number; sgst: number }
}): Promise<AdvanceOrder> {
  if (input.paymentMethod === 'split') {
    if (Math.abs(splitTotal(parseSplit(input.splitDetails)) - Number(input.depositAmount)) >= 0.01) {
      throw new Error('Split payment amounts must add up to the deposit amount.')
    }
  }
  const splitDetails = input.paymentMethod === 'split' ? parseSplit(input.splitDetails) : {}

  let createdOrder: AdvanceOrder | null = null

  if (isDatabaseConfigured) {
    try {
      const { data, error } = await db.rpc('create_advance_order', {
        p_customer_name: input.customerName, p_phone: input.phone, p_address: input.address, p_product_name: input.productName,
        p_category: input.category, p_description: input.description, p_total_amount: input.totalAmount,
        p_deposit_amount: input.depositAmount, p_expected_delivery_date: input.expectedDeliveryDate, p_remarks: input.remarks,
        p_payment_method: input.paymentMethod, p_created_by_name: input.createdByName, p_products: input.products || [],
        ...(input.paymentMethod === 'split' ? { p_split_details: splitDetails } : {}),
      })
      if (error) {
        console.error('[createAdvanceOrder] Supabase error:', error.message)
      } else if (data) {
        createdOrder = normalizeOrder(rpcRow(data))
        // Patch columns that are not RPC params (reference number + price breakdown)
        const patch: Record<string, unknown> = {}
        if ((input.referenceNumber || '').trim()) patch.reference_number = (input.referenceNumber || '').trim()
        if (input.breakdown) Object.assign(patch, breakdownColumns(input.breakdown))
        if (Object.keys(patch).length > 0) {
          const { error: patchError } = await db.from('advance_orders').update(patch).eq('id', createdOrder.id)
          if (patchError) throw new Error(patchError.message)
          createdOrder = { ...createdOrder, ...patch } as AdvanceOrder
        }
      }
    } catch (err) {
      console.error('[createAdvanceOrder] Exception:', err)
      if (createdOrder) throw new Error(`Advance order was created, but its reference number / price breakdown could not be saved (run the latest Supabase migration): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!createdOrder) {
    const now = new Date()
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const seq = String(Math.floor(1000 + Math.random() * 9000))
    const depositId = `DEP-${ymd}-${seq}`
    const orderId = crypto.randomUUID ? crypto.randomUUID() : `adv_${Date.now()}_${Math.random().toString(36).slice(2)}`

    createdOrder = {
      id: orderId,
      deposit_id: depositId,
      customer_name: input.customerName.trim(),
      phone: input.phone.trim(),
      address: input.address.trim(),
      product_name: input.productName.trim(),
      products: input.products || [{ name: input.productName, category: input.category, quantity: 1, base_price: input.totalAmount, line_total: input.totalAmount }],
      category: input.category.trim(),
      description: input.description.trim(),
      total_amount: Number(input.totalAmount),
      ...(input.breakdown ? breakdownColumns(input.breakdown) : {}),
      deposit_amount: Number(input.depositAmount),
      remaining_balance: Number(input.totalAmount) - Number(input.depositAmount),
      expected_delivery_date: input.expectedDeliveryDate,
      status: 'pending_deposit',
      remarks: input.remarks.trim(),
      reference_number: (input.referenceNumber || '').trim(),
      created_by_name: input.createdByName,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      completed_at: null,
      completed_order_id: null,
      invoice_number: null,
      final_payment_method: null,
    }

    const currentTimeline = loadLocalTimeline()
    currentTimeline.push(
      { id: Date.now(), advance_order_id: orderId, event_type: 'created', label: 'Deposit Created', remarks: input.remarks, created_at: now.toISOString() },
      { id: Date.now() + 1, advance_order_id: orderId, event_type: 'deposit_received', label: 'Deposit Received', remarks: `Received INR ${input.depositAmount} via ${input.paymentMethod.toLowerCase() === 'upi' ? 'QR' : input.paymentMethod.toUpperCase()}`, created_at: now.toISOString() }
    )
    saveLocalTimeline(currentTimeline)

    const currentPayments = loadLocalPayments()
    currentPayments.push({
      id: orderId + '_dep',
      advance_order_id: orderId,
      payment_type: 'deposit',
      amount: Number(input.depositAmount),
      payment_method: input.paymentMethod,
      split_details: splitDetails,
      remarks: input.remarks,
      received_at: now.toISOString(),
    })
    saveLocalPayments(currentPayments)
  }

  const localOrders = loadLocalOrders()
  const updated = [createdOrder, ...localOrders.filter(o => o.id !== createdOrder!.id)]
  saveLocalOrders(updated)
  return createdOrder
}

/** Saves the shop-only reference number and remarks of an advance order. */
export async function updateAdvanceInternalNotes(orderId: string, referenceNumber: string, remarks: string): Promise<void> {
  const patch = { reference_number: referenceNumber.trim(), remarks: remarks.trim(), updated_at: new Date().toISOString() }
  if (isDatabaseConfigured) {
    const { error } = await db.from('advance_orders').update(patch).eq('id', orderId)
    if (error) throw new Error(error.message)
    return
  }
  saveLocalOrders(loadLocalOrders().map(o => (o.id === orderId ? { ...o, ...patch } : o)))
}

export async function updateAdvanceStatus(orderId: string, status: AdvanceStatus, remarks = ''): Promise<AdvanceOrder> {
  let updatedOrder: AdvanceOrder | null = null

  if (isDatabaseConfigured) {
    try {
      const { data, error } = await db.rpc('update_advance_order_status', { p_order_id: orderId, p_status: status, p_remarks: remarks })
      if (error) {
        console.error('[updateAdvanceStatus] Supabase error:', error.message)
      } else if (data) {
        updatedOrder = normalizeOrder(rpcRow(data))
      }
    } catch (err) { console.error('[updateAdvanceStatus] Exception:', err) }
  }

  const localOrders = loadLocalOrders()
  const existing = localOrders.find(o => o.id === orderId)
  if (!updatedOrder && existing) {
    const now = new Date().toISOString()
    const label = status === 'ready_for_delivery' ? 'Ready for Delivery' : status === 'waiting_final_payment' ? 'Customer Contacted' : status === 'cancelled' ? 'Cancelled' : 'Pending Deposit'
    updatedOrder = { ...existing, status, remarks: remarks || existing.remarks, updated_at: now }

    const timeline = loadLocalTimeline()
    timeline.push({ id: Date.now(), advance_order_id: orderId, event_type: status, label, remarks, created_at: now })
    saveLocalTimeline(timeline)
  }

  if (updatedOrder) {
    saveLocalOrders(localOrders.map(o => o.id === orderId ? updatedOrder! : o))
    return updatedOrder
  }
  throw new Error('Order not found')
}

export async function addAdvanceEvent(orderId: string, eventType: string, label: string, remarks = '') {
  if (isDatabaseConfigured) {
    try {
      await db.rpc('add_advance_order_event', { p_order_id: orderId, p_event_type: eventType, p_label: label, p_remarks: remarks })
    } catch { /* fallback */ }
  }
  const timeline = loadLocalTimeline()
  timeline.push({ id: Date.now(), advance_order_id: orderId, event_type: eventType, label, remarks, created_at: new Date().toISOString() })
  saveLocalTimeline(timeline)
}

export async function completeAdvanceOrder(
  orderId: string, 
  paymentMethod: AdvancePaymentMethod, 
  finalAmount: number,
  couponCode: string | null = null,
  couponPercentage: number = 0,
  manualDiscountAmount: number = 0,
  remarks = '',
  splitInput?: SplitDetails
) {
  let result: { order_id: string; invoice_no: string; completed_at: string; split_details?: SplitDetails } | null = null
  if (paymentMethod === 'split' && Math.abs(splitTotal(parseSplit(splitInput)) - Number(finalAmount)) >= 0.01) {
    throw new Error('Split payment amounts must add up to the final amount.')
  }
  const splitDetails = paymentMethod === 'split' ? parseSplit(splitInput) : {}

  if (isDatabaseConfigured) {
    try {
      const { data, error } = await db.rpc('complete_advance_order_v2', { 
        p_order_id: orderId, 
        p_payment_method: paymentMethod,
        p_final_amount: finalAmount,
        p_coupon_code: couponCode,
        p_coupon_percentage: couponPercentage,
        p_manual_discount: manualDiscountAmount,
        p_remarks: remarks,
        ...(paymentMethod === 'split' ? { p_split_details: splitDetails } : {}),
      })
      if (error) {
        if (error.message?.includes('already generated') || error.message?.includes('already completed')) {
          // Self-heal: order was already completed with invoice
          const { data: existing } = await db.from('advance_orders').select('*').eq('id', orderId).maybeSingle()
          if (existing && (existing.invoice_number || existing.completed_order_id)) {
            result = {
              order_id: existing.completed_order_id || existing.id,
              invoice_no: existing.invoice_number || 'INV-COMPLETED',
              completed_at: existing.completed_at || new Date().toISOString()
            }
          } else {
            throw new Error('This order has already been completed.')
          }
        } else {
          throw new Error(error.message || JSON.stringify(error))
        }
      }
      if (data) {
        const row = Array.isArray(data) ? data[0] : data
        result = row as { order_id: string; invoice_no: string; completed_at: string }
        // Full collection breakdown (deposit + final) written by the database for analytics
        try {
          const { data: orderRow } = await db.from('orders').select('split_details').eq('id', result.order_id).maybeSingle()
          if (orderRow && splitTotal(parseSplit(orderRow.split_details)) > 0) result.split_details = parseSplit(orderRow.split_details)
        } catch { /* optional */ }
      }
    } catch (err: unknown) {
      if (!result) {
        alert(`Supabase Backend Error: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    }
  }

  const localOrders = loadLocalOrders()
  const order = localOrders.find(o => o.id === orderId)
  const now = new Date().toISOString()

  if (!result) {
    const invoiceNo = `INV${nextLocalInvoiceSeq()}`
    const completedOrderId = crypto.randomUUID ? crypto.randomUUID() : `ord_${Date.now()}_${Math.random().toString(36).slice(2)}`
    result = { order_id: completedOrderId, invoice_no: invoiceNo, completed_at: now }
  }

  if (order) {
    const updatedOrder: AdvanceOrder = {
      ...order,
      status: 'completed',
      completed_at: result.completed_at,
      completed_order_id: result.order_id,
      invoice_number: result.invoice_no,
      final_payment_method: paymentMethod,
      split_details: result.split_details,
      remarks: remarks || order.remarks,
      updated_at: now,
    }
    saveLocalOrders(localOrders.map(o => o.id === orderId ? updatedOrder : o))

    const timeline = loadLocalTimeline()
    timeline.push(
      { id: Date.now(), advance_order_id: orderId, event_type: 'remaining_payment_received', label: 'Final Payment Received', remarks, created_at: now },
      { id: Date.now() + 1, advance_order_id: orderId, event_type: 'delivered', label: 'Delivered', remarks, created_at: now },
      { id: Date.now() + 2, advance_order_id: orderId, event_type: 'revenue_posted', label: `Revenue Posted (INR ${order.total_amount})`, remarks, created_at: now },
      { id: Date.now() + 3, advance_order_id: orderId, event_type: 'invoice_generated', label: `Invoice Generated (${result.invoice_no})`, remarks, created_at: now }
    )
    saveLocalTimeline(timeline)

    const payments = loadLocalPayments()
    payments.push({
      id: orderId + '_rem',
      advance_order_id: orderId,
      payment_type: 'remaining',
      amount: order.remaining_balance,
      payment_method: paymentMethod,
      split_details: splitDetails,
      remarks,
      received_at: now,
    })
    saveLocalPayments(payments)
  }

  return result!
}
