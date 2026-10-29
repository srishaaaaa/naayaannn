import { normalizePhoneForWhatsApp } from '../lib/phone'
import { BRAND_EN, BRAND_INSTAGRAM, BRAND_PHONE_DISPLAY } from '../lib/brand'
import { db, isDatabaseConfigured } from '../lib/db'

export interface CustomerBirthday {
  id: string
  name: string
  phone: string
  birth_date: string // YYYY-MM-DD
  created_at?: string
}

export interface BirthdayOffer {
  id: string
  label: string
}

export type BirthdayRange = 'today' | 'week' | 'month' | 'all'

const LOCAL_KEY = 'universallook_birthdays_v1'
const OFFERS_KEY = 'universallook_birthday_offers_v1'
const TEMPLATE_KEY = 'universallook_birthday_template_v1'

export const DEFAULT_TEMPLATE =
  'Hi {name}! 🎂 Happy Birthday!\n\nHere\'s a special treat from {shop}:\n🎁 {offer}\n\nVisit us in store or call {phone}.\nFollow us on Instagram @{instagram}\n\n– {shop}'

const DEFAULT_OFFERS: BirthdayOffer[] = [{ id: 'default-20', label: '20% OFF' }]

const readLocal = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}
const writeLocal = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}

const phoneKey = (phone: string) => normalizePhoneForWhatsApp(phone) || phone.trim()

export interface KnownCustomer { name: string; phone: string }

export const birthdayService = {
  async list(): Promise<CustomerBirthday[]> {
    const local = readLocal<CustomerBirthday[]>(LOCAL_KEY, [])
    if (isDatabaseConfigured) {
      const { data, error } = await db
        .from('customer_birthdays')
        .select('id, name, phone, birth_date, created_at')
        .order('name', { ascending: true })
      if (!error && data) {
        // The database is the source of truth; the device copy is only used when it cannot be reached
        const remote = data as CustomerBirthday[]
        writeLocal(LOCAL_KEY, remote)
        return remote
      }
      console.warn('Birthday fetch failed, using local cache:', error?.message)
    }
    return local
  },

  /** Customers who have bought (billing + advance orders) but have no birthday saved yet. */
  async listWithoutBirthday(withBirthday: CustomerBirthday[]): Promise<KnownCustomer[]> {
    const have = new Set(withBirthday.map(b => phoneKey(b.phone)))
    const found = new Map<string, KnownCustomer>()
    const add = (name: unknown, phone: unknown) => {
      const raw = String(phone || '').trim()
      if (!raw) return
      const key = phoneKey(raw)
      if (!key || have.has(key)) return
      const nm = String(name || '').trim()
      const prev = found.get(key)
      if (!prev || (!prev.name && nm)) found.set(key, { name: nm, phone: key })
    }
    if (isDatabaseConfigured) {
      const [orders, advance] = await Promise.all([
        db.from('orders').select('customer_name, phone').not('phone', 'is', null).limit(5000),
        db.from('advance_orders').select('customer_name, phone').not('phone', 'is', null).limit(5000),
      ])
      for (const r of (orders.data || []) as Array<Record<string, unknown>>) add(r.customer_name, r.phone)
      for (const r of (advance.data || []) as Array<Record<string, unknown>>) add(r.customer_name, r.phone)
    }
    return [...found.values()].sort((a, b) => (a.name || '~').localeCompare(b.name || '~'))
  },

  /** Insert or update the birthday for a phone number. Never throws: billing must not fail because of this. */
  async save(input: { name: string; phone: string; birthDate: string }): Promise<void> {
    const phone = phoneKey(input.phone)
    if (!phone || !input.birthDate) return
    const row = { name: input.name.trim(), phone, birth_date: input.birthDate, updated_at: new Date().toISOString() }
    if (isDatabaseConfigured) {
      const { error } = await db.from('customer_birthdays').upsert(row, { onConflict: 'phone' })
      if (!error) return
      console.warn('Birthday save failed, caching locally:', error.message)
    }
    const all = readLocal<CustomerBirthday[]>(LOCAL_KEY, []).filter(b => b.phone !== phone)
    all.push({ id: `local-${phone}`, name: row.name, phone, birth_date: row.birth_date })
    writeLocal(LOCAL_KEY, all)
  },

  async remove(id: string): Promise<void> {
    if (!id.startsWith('local-') && isDatabaseConfigured) {
      const { error } = await db.from('customer_birthdays').delete().eq('id', id)
      if (error) throw new Error(error.message)
    }
    writeLocal(LOCAL_KEY, readLocal<CustomerBirthday[]>(LOCAL_KEY, []).filter(b => b.id !== id))
  },

  getOffers: (): BirthdayOffer[] => {
    const offers = readLocal<BirthdayOffer[]>(OFFERS_KEY, [])
    return offers.length ? offers : DEFAULT_OFFERS
  },
  saveOffers: (offers: BirthdayOffer[]) => writeLocal(OFFERS_KEY, offers),
  getTemplate: (): string => readLocal<string>(TEMPLATE_KEY, DEFAULT_TEMPLATE),
  saveTemplate: (t: string) => writeLocal(TEMPLATE_KEY, t),
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "MM-DD" key for a Date. Birthdays are matched on month and day only; the year is never used. */
export const toMonthDay = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** "MM-DD" part of a stored YYYY-MM-DD birth date. */
export const birthMonthDay = (iso: string) => iso.slice(5, 10)

/** DD/MM for display (year intentionally omitted). */
export const formatBirthDate = (iso: string) => {
  const [, m, d] = iso.split('-')
  return m && d ? `${d}/${m}` : iso
}

/** Whether a "MM-DD" key falls in [from, to] (both "MM-DD", either may be empty). Ranges may wrap over New Year. */
export const monthDayInWindow = (key: string, from: string, to: string) => {
  const f = from || '01-01'
  const t = to || '12-31'
  return f <= t ? key >= f && key <= t : key >= f || key <= t
}

export const birthdayInWindow = (iso: string, from: string, to: string) =>
  monthDayInWindow(birthMonthDay(iso), from, to)

export const rangeToDates = (range: BirthdayRange, today = new Date()): { from: string; to: string } => {
  switch (range) {
    case 'today': return { from: toMonthDay(today), to: toMonthDay(today) }
    case 'week': return { from: toMonthDay(today), to: toMonthDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6)) }
    case 'month': {
      const last = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
      return { from: `${pad(today.getMonth() + 1)}-01`, to: `${pad(today.getMonth() + 1)}-${pad(last)}` }
    }
    default: return { from: '', to: '' }
  }
}

export const buildBirthdayMessage = (template: string, name: string, offer: string) =>
  template
    .replace(/\{name\}/g, name.trim() || 'Customer')
    .replace(/\{offer\}/g, offer)
    .replace(/\{shop\}/g, BRAND_EN)
    .replace(/\{phone\}/g, BRAND_PHONE_DISPLAY)
    .replace(/\{instagram\}/g, BRAND_INSTAGRAM)
