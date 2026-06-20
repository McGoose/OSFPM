import React, { useState, useEffect, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'
import { useSettings } from '../../context/SettingsContext'
import { useAuth } from '../../context/AuthContext'

const SECTIONS = [
  { key: 'above_the_line', label: 'Above-the-Line' },
  { key: 'below_the_line', label: 'Below-the-Line' },
  { key: 'post_production', label: 'Post Production' },
  { key: 'other', label: 'Other' },
]

const UNITS = [
  { value: 'flat',  label: 'Flat' },
  { value: 'day',   label: 'Day' },
  { value: 'week',  label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'hour',  label: 'Hour' },
  { value: 'shoot', label: 'Shoot Day' },
  { value: 'other', label: 'Other' },
]

const INVOICE_STATUSES = [
  { value: 'pending',  label: 'Pending',  cls: 'inv-status--pending' },
  { value: 'approved', label: 'Approved', cls: 'inv-status--approved' },
  { value: 'paid',     label: 'Paid',     cls: 'inv-status--paid' },
  { value: 'rejected', label: 'Rejected', cls: 'inv-status--rejected' },
]

const blankInvoice = { vendor: '', invoiceNumber: '', invoiceDate: '', amount: '', status: 'pending', description: '', budgetLineId: '', notes: '' }

export default function Budget() {
  const { id } = useParams()
  const { currentProject } = useProject()
  const { settings } = useSettings()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [tab, setTab] = useState('budget')
  const [categories, setCategories] = useState([])
  const [invoiceList, setInvoiceList] = useState([])
  const [coprods, setCoprods] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Invoice form state
  const [newInv, setNewInv] = useState(blankInvoice)
  const [addingInv, setAddingInv] = useState(false)
  const [invFilter, setInvFilter] = useState('all')
  const [addCoprodName, setAddCoprodName] = useState('')

  const fmt = useCallback((n) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: settings.currency || 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(n || 0),
  [settings.currency])

  const fmtDate = (d) => {
    if (!d) return ''
    try { return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) }
    catch { return d }
  }

  const load = useCallback(async () => {
    try {
      const [bRes, iRes, cRes] = await Promise.all([
        fetch(`/api/projects/${id}/budget`, { credentials: 'include' }),
        fetch(`/api/projects/${id}/invoices`, { credentials: 'include' }),
        fetch(`/api/projects/${id}/coproducers`, { credentials: 'include' }),
      ])
      const [bData, iData, cData] = await Promise.all([bRes.json(), iRes.json(), cRes.json()])
      setCategories(Array.isArray(bData) ? bData : [])
      setInvoiceList(Array.isArray(iData) ? iData : [])
      setCoprods(Array.isArray(cData) ? cData : [])
    } catch {
      setError('Failed to load budget data')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // ── Budget actions ─────────────────────────────────────────────────────────

  const seed = async () => {
    setError('')
    const res = await fetch(`/api/projects/${id}/budget/seed`, { method: 'POST', credentials: 'include' })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return }
    setCategories(Array.isArray(data) ? data : [])
  }

  const addLine = async (categoryId) => {
    const res = await fetch(`/api/projects/${id}/budget/lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ categoryId }),
    })
    const newLine = await res.json()
    setCategories(cats => cats.map(c => c.id === categoryId ? { ...c, lines: [...c.lines, newLine] } : c))
  }

  const saveLineField = async (lineId, catId, field, value) => {
    const parsed = ['qty', 'rate'].includes(field) ? (parseFloat(value) || 0) : value
    // Optimistic: update total locally
    setCategories(cats => cats.map(cat => {
      if (cat.id !== catId) return cat
      return {
        ...cat,
        lines: cat.lines.map(l => {
          if (l.id !== lineId) return l
          const updated = { ...l, [field]: parsed }
          updated.total = (updated.qty || 0) * (updated.rate || 0)
          return updated
        }),
      }
    }))
    await fetch(`/api/projects/${id}/budget/lines/${lineId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ [field]: parsed }),
    })
  }

  const deleteLine = async (lineId, catId) => {
    await fetch(`/api/projects/${id}/budget/lines/${lineId}`, { method: 'DELETE', credentials: 'include' })
    setCategories(cats => cats.map(c => c.id === catId ? { ...c, lines: c.lines.filter(l => l.id !== lineId) } : c))
  }

  const saveCategoryName = async (catId, name) => {
    setCategories(cats => cats.map(c => c.id === catId ? { ...c, name } : c))
    await fetch(`/api/projects/${id}/budget/categories/${catId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name }),
    })
  }

  const deleteCategory = async (catId, catName) => {
    if (!confirm(`Delete "${catName}" and all its lines?`)) return
    await fetch(`/api/projects/${id}/budget/categories/${catId}`, { method: 'DELETE', credentials: 'include' })
    setCategories(cats => cats.filter(c => c.id !== catId))
  }

  const addCategory = async (section) => {
    const res = await fetch(`/api/projects/${id}/budget/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: 'New Category', section }),
    })
    const newCat = await res.json()
    setCategories(cats => [...cats, { ...newCat, lines: [] }])
  }

  // ── Invoice actions ────────────────────────────────────────────────────────

  const submitInvoice = async (e) => {
    e.preventDefault()
    const res = await fetch(`/api/projects/${id}/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ...newInv, budgetLineId: newInv.budgetLineId || null }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return }
    setInvoiceList(list => [...list, data])
    setNewInv(blankInvoice)
    setAddingInv(false)
  }

  const updateInvoiceField = async (invId, field, value) => {
    setInvoiceList(list => list.map(inv => inv.id !== invId ? inv : { ...inv, [field]: value }))
    await fetch(`/api/projects/${id}/invoices/${invId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ [field]: value === '' ? null : value }),
    })
  }

  const deleteInvoice = async (invId, vendor) => {
    if (!confirm(`Delete invoice from "${vendor || 'unknown vendor'}"?`)) return
    await fetch(`/api/projects/${id}/invoices/${invId}`, { method: 'DELETE', credentials: 'include' })
    setInvoiceList(list => list.filter(inv => inv.id !== invId))
  }

  // ── Co-producer actions ────────────────────────────────────────────────────

  const addCoprod = async () => {
    if (!addCoprodName.trim()) return
    const res = await fetch(`/api/projects/${id}/coproducers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: addCoprodName.trim(), sharePercent: 0 }),
    })
    const row = await res.json()
    setCoprods(c => [...c, row])
    setAddCoprodName('')
  }

  const saveCoprodField = async (cpId, field, value) => {
    setCoprods(c => c.map(r => r.id !== cpId ? r : { ...r, [field]: field === 'sharePercent' ? (parseFloat(value) || 0) : value }))
    await fetch(`/api/projects/${id}/coproducers/${cpId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ [field]: field === 'sharePercent' ? (parseFloat(value) || 0) : value }),
    })
  }

  const deleteCoprod = async (cpId, name) => {
    if (!confirm(`Remove "${name}" from this project?`)) return
    await fetch(`/api/projects/${id}/coproducers/${cpId}`, { method: 'DELETE', credentials: 'include' })
    setCoprods(c => c.filter(r => r.id !== cpId))
  }

  // ── Computed totals ────────────────────────────────────────────────────────

  const sectionTotals = SECTIONS.reduce((acc, s) => { acc[s.key] = 0; return acc }, {})
  for (const cat of categories) {
    if (sectionTotals[cat.section] !== undefined) {
      for (const l of cat.lines) sectionTotals[cat.section] += (l.qty || 0) * (l.rate || 0)
    }
  }
  const grandBudget = Object.values(sectionTotals).reduce((s, t) => s + t, 0)

  const totalInvoiced = invoiceList.reduce((s, inv) => s + (parseFloat(inv.amount) || 0), 0)
  const totalPaid     = invoiceList.filter(inv => inv.status === 'paid').reduce((s, inv) => s + (parseFloat(inv.amount) || 0), 0)
  const totalApproved = invoiceList.filter(inv => inv.status === 'approved').reduce((s, inv) => s + (parseFloat(inv.amount) || 0), 0)
  const totalPending  = invoiceList.filter(inv => inv.status === 'pending').reduce((s, inv) => s + (parseFloat(inv.amount) || 0), 0)

  // All budget lines flattened (for invoice dropdown)
  const allLines = categories.flatMap(cat => cat.lines.map(l => ({ ...l, catName: cat.name })))

  const filteredInvoices = invFilter === 'all' ? invoiceList : invoiceList.filter(inv => inv.status === invFilter)

  if (loading) return <div className="loading" style={{ minHeight: 200 }}>Loading budget…</div>

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← Overview</Link>
        <div className="page-header-row">
          <div>
            <h1>Budget Tracker</h1>
            <p className="page-subtitle">{currentProject?.title}</p>
          </div>
        </div>
      </div>

      {error && <p className="auth-error" style={{ marginBottom: 16 }}>{error}</p>}

      {/* Summary cards */}
      <div className="budget-summary">
        <div className="budget-summary-card">
          <div className="budget-summary-label">Total Budget</div>
          <div className="budget-summary-value">{fmt(grandBudget)}</div>
        </div>
        <div className="budget-summary-card">
          <div className="budget-summary-label">Total Invoiced</div>
          <div className="budget-summary-value">{fmt(totalInvoiced)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {fmt(totalPending)} pending · {fmt(totalApproved)} approved
          </div>
        </div>
        <div className={`budget-summary-card${totalPaid > grandBudget && totalPaid > 0 ? ' budget-summary-card--over' : totalPaid > 0 && totalPaid <= grandBudget ? ' budget-summary-card--under' : ''}`}>
          <div className="budget-summary-label">Paid</div>
          <div className={`budget-summary-value${totalPaid > grandBudget && grandBudget > 0 ? ' budget-over' : totalPaid > 0 && grandBudget > 0 && totalPaid < grandBudget ? ' budget-under' : ''}`}>
            {fmt(totalPaid)}
          </div>
          {grandBudget > 0 && totalPaid > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              {fmt(grandBudget - totalPaid)} remaining
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="budget-tabs">
        <button className={`budget-tab${tab === 'budget' ? ' budget-tab--active' : ''}`} onClick={() => setTab('budget')}>
          Budget Plan
        </button>
        <button className={`budget-tab${tab === 'invoices' ? ' budget-tab--active' : ''}`} onClick={() => setTab('invoices')}>
          Invoices
          {invoiceList.length > 0 && <span className="budget-tab-count">{invoiceList.length}</span>}
        </button>
      </div>

      {/* ── BUDGET TAB ── */}
      {tab === 'budget' && (
        categories.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">💰</div>
            <p>No budget set up for this project yet.</p>
            {isAdmin ? (
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ width: 'auto', padding: '9px 20px' }} onClick={seed}>
                  Copy from company template
                </button>
                {SECTIONS.map(s => (
                  <button key={s.key} className="btn-secondary" style={{ width: 'auto', padding: '9px 16px' }} onClick={() => addCategory(s.key)}>
                    + {s.label} category
                  </button>
                ))}
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)', marginTop: 8, fontSize: 13 }}>Ask an admin to set up the budget.</p>
            )}
          </div>
        ) : (
          <div className="budget-table-wrap">
            <table className="budget-table">
              <thead>
                <tr>
                  <th className="budget-col-desc">Description</th>
                  <th className="budget-col-qty">Qty</th>
                  <th className="budget-col-unit">Unit</th>
                  <th className="budget-col-num">Rate ({settings.currency || 'USD'})</th>
                  <th className="budget-col-num">Total ({settings.currency || 'USD'})</th>
                  <th className="budget-col-act"></th>
                </tr>
              </thead>
              <tbody>
                {SECTIONS.map(section => {
                  const sectionCats = categories.filter(c => c.section === section.key)
                  const st = sectionTotals[section.key] || 0
                  return (
                    <React.Fragment key={section.key}>
                      <tr className="budget-section-header">
                        <td colSpan={6}>{section.label}</td>
                      </tr>

                      {sectionCats.map(cat => {
                        const catTotal = cat.lines.reduce((s, l) => s + (l.qty || 0) * (l.rate || 0), 0)
                        return (
                          <React.Fragment key={cat.id}>
                            <tr className="budget-category-row">
                              <td>
                                {isAdmin ? (
                                  <input className="budget-cat-input" defaultValue={cat.name} onBlur={e => saveCategoryName(cat.id, e.target.value)} />
                                ) : (
                                  <span className="budget-cat-label">{cat.name}</span>
                                )}
                              </td>
                              <td></td><td></td><td></td>
                              <td className="budget-num">{catTotal > 0 ? fmt(catTotal) : ''}</td>
                              <td className="budget-col-act">
                                {isAdmin && <button className="budget-delete-btn" onClick={() => deleteCategory(cat.id, cat.name)}>✕</button>}
                              </td>
                            </tr>

                            {cat.lines.map(line => (
                              <tr key={line.id} className="budget-line-row">
                                <td className="budget-line-indent">
                                  <input
                                    className="budget-inline-input"
                                    defaultValue={line.description}
                                    onBlur={e => saveLineField(line.id, cat.id, 'description', e.target.value)}
                                    placeholder="Description"
                                    readOnly={!isAdmin}
                                  />
                                </td>
                                <td>
                                  <input
                                    className="budget-inline-input budget-num-input"
                                    type="number" min="0" step="any"
                                    defaultValue={line.qty ?? 1}
                                    onBlur={e => saveLineField(line.id, cat.id, 'qty', e.target.value)}
                                    readOnly={!isAdmin}
                                  />
                                </td>
                                <td>
                                  {isAdmin ? (
                                    <select
                                      className="budget-unit-select"
                                      defaultValue={line.unit || 'flat'}
                                      onBlur={e => saveLineField(line.id, cat.id, 'unit', e.target.value)}
                                      onChange={e => saveLineField(line.id, cat.id, 'unit', e.target.value)}
                                    >
                                      {UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                                    </select>
                                  ) : (
                                    <span className="budget-unit-label">{UNITS.find(u => u.value === line.unit)?.label || line.unit}</span>
                                  )}
                                </td>
                                <td>
                                  <input
                                    className="budget-inline-input budget-num-input"
                                    type="number" min="0" step="any"
                                    defaultValue={line.rate || ''}
                                    onBlur={e => saveLineField(line.id, cat.id, 'rate', e.target.value)}
                                    placeholder="0"
                                    readOnly={!isAdmin}
                                  />
                                </td>
                                <td className="budget-num" style={{ color: 'var(--text-secondary)', paddingRight: 12 }}>
                                  {(line.qty || 0) * (line.rate || 0) > 0 ? fmt((line.qty || 0) * (line.rate || 0)) : ''}
                                </td>
                                <td className="budget-col-act">
                                  {isAdmin && <button className="budget-delete-btn" onClick={() => deleteLine(line.id, cat.id)}>✕</button>}
                                </td>
                              </tr>
                            ))}

                            {isAdmin && (
                              <tr className="budget-add-row">
                                <td colSpan={6}>
                                  <button className="budget-add-btn" onClick={() => addLine(cat.id)}>+ Add line</button>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        )
                      })}

                      <tr className="budget-section-total">
                        <td colSpan={4}>Total {section.label}</td>
                        <td className="budget-num">{fmt(st)}</td>
                        <td>
                          {isAdmin && (
                            <button className="budget-add-btn" style={{ padding: '2px 8px' }} onClick={() => addCategory(section.key)}>
                              + Category
                            </button>
                          )}
                        </td>
                      </tr>
                    </React.Fragment>
                  )
                })}

                <tr className="budget-grand-total">
                  <td colSpan={4}>Grand Total</td>
                  <td className="budget-num">{fmt(grandBudget)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ── INVOICES TAB ── */}
      {tab === 'invoices' && (
        <div>
          {/* Invoice totals bar */}
          {invoiceList.length > 0 && (
            <div className="inv-summary-bar">
              <div className="inv-summary-item">
                <span className="inv-status-dot inv-status-dot--pending"></span>
                Pending: <strong>{fmt(totalPending)}</strong>
              </div>
              <div className="inv-summary-item">
                <span className="inv-status-dot inv-status-dot--approved"></span>
                Approved: <strong>{fmt(totalApproved)}</strong>
              </div>
              <div className="inv-summary-item">
                <span className="inv-status-dot inv-status-dot--paid"></span>
                Paid: <strong>{fmt(totalPaid)}</strong>
              </div>
              <div className="inv-summary-item inv-summary-total">
                Total: <strong>{fmt(totalInvoiced)}</strong>
              </div>
            </div>
          )}

          {/* Filter + Add button row */}
          <div className="inv-toolbar">
            <div className="inv-filters">
              {['all', 'pending', 'approved', 'paid', 'rejected'].map(f => (
                <button
                  key={f}
                  className={`inv-filter-btn${invFilter === f ? ' inv-filter-btn--active' : ''}`}
                  onClick={() => setInvFilter(f)}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                  <span className="inv-filter-count">
                    {f === 'all' ? invoiceList.length : invoiceList.filter(i => i.status === f).length}
                  </span>
                </button>
              ))}
            </div>
            <button className="btn-primary" style={{ width: 'auto', padding: '7px 16px', fontSize: 13 }} onClick={() => setAddingInv(v => !v)}>
              {addingInv ? 'Cancel' : '+ Add Invoice'}
            </button>
          </div>

          {/* Add invoice form */}
          {addingInv && (
            <form className="inv-add-form" onSubmit={submitInvoice}>
              <div className="inv-add-grid">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Vendor / Supplier</label>
                  <input value={newInv.vendor} onChange={e => setNewInv(v => ({ ...v, vendor: e.target.value }))} placeholder="e.g. BBC Film" required />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Invoice #</label>
                  <input value={newInv.invoiceNumber} onChange={e => setNewInv(v => ({ ...v, invoiceNumber: e.target.value }))} placeholder="INV-001" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Date</label>
                  <input type="date" value={newInv.invoiceDate} onChange={e => setNewInv(v => ({ ...v, invoiceDate: e.target.value }))} />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Amount ({settings.currency || 'USD'})</label>
                  <input type="number" min="0" step="any" value={newInv.amount} onChange={e => setNewInv(v => ({ ...v, amount: e.target.value }))} placeholder="0" required />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Status</label>
                  <select value={newInv.status} onChange={e => setNewInv(v => ({ ...v, status: e.target.value }))}>
                    {INVOICE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Budget line (optional)</label>
                  <select value={newInv.budgetLineId} onChange={e => setNewInv(v => ({ ...v, budgetLineId: e.target.value }))}>
                    <option value="">— Unassigned —</option>
                    {allLines.map(l => (
                      <option key={l.id} value={l.id}>{l.catName} › {l.description}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
                  <label>Description / Notes</label>
                  <input value={newInv.description} onChange={e => setNewInv(v => ({ ...v, description: e.target.value }))} placeholder="What this invoice covers…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button type="submit" className="btn-primary" style={{ width: 'auto', padding: '8px 20px' }}>Add Invoice</button>
                <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '8px 16px' }} onClick={() => { setAddingInv(false); setNewInv(blankInvoice) }}>Cancel</button>
              </div>
            </form>
          )}

          {/* Invoice table */}
          {filteredInvoices.length === 0 ? (
            <div className="empty-state" style={{ padding: '48px 20px' }}>
              <div className="empty-state-icon">🧾</div>
              <p>{invFilter === 'all' ? 'No invoices recorded yet.' : `No ${invFilter} invoices.`}</p>
            </div>
          ) : (
            <div className="budget-table-wrap" style={{ marginTop: 0 }}>
              <table className="budget-table">
                <thead>
                  <tr>
                    <th style={{ width: '5%' }}>Status</th>
                    <th style={{ width: '18%' }}>Vendor</th>
                    <th style={{ width: '10%' }}>Invoice #</th>
                    <th style={{ width: '10%' }}>Date</th>
                    <th className="budget-col-num" style={{ width: '12%' }}>Amount</th>
                    <th style={{ width: '20%' }}>Budget Line</th>
                    <th style={{ width: '20%' }}>Description</th>
                    <th className="budget-col-act"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map(inv => {
                    const linked = allLines.find(l => l.id === inv.budgetLineId)
                    const statusInfo = INVOICE_STATUSES.find(s => s.value === inv.status) || INVOICE_STATUSES[0]
                    return (
                      <tr key={inv.id} className="budget-line-row">
                        <td>
                          <select
                            className={`inv-status-select ${statusInfo.cls}`}
                            value={inv.status}
                            onChange={e => updateInvoiceField(inv.id, 'status', e.target.value)}
                          >
                            {INVOICE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                          </select>
                        </td>
                        <td>
                          <input
                            className="budget-inline-input"
                            defaultValue={inv.vendor}
                            onBlur={e => updateInvoiceField(inv.id, 'vendor', e.target.value)}
                            placeholder="Vendor"
                          />
                        </td>
                        <td>
                          <input
                            className="budget-inline-input"
                            defaultValue={inv.invoiceNumber}
                            onBlur={e => updateInvoiceField(inv.id, 'invoiceNumber', e.target.value)}
                            placeholder="INV-001"
                          />
                        </td>
                        <td>
                          <input
                            className="budget-inline-input"
                            type="date"
                            defaultValue={inv.invoiceDate}
                            onBlur={e => updateInvoiceField(inv.id, 'invoiceDate', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="budget-inline-input budget-num-input"
                            type="number" min="0" step="any"
                            defaultValue={inv.amount}
                            onBlur={e => updateInvoiceField(inv.id, 'amount', e.target.value)}
                          />
                        </td>
                        <td>
                          <select
                            className="budget-unit-select"
                            value={inv.budgetLineId || ''}
                            onChange={e => updateInvoiceField(inv.id, 'budgetLineId', e.target.value || null)}
                          >
                            <option value="">— Unassigned —</option>
                            {allLines.map(l => (
                              <option key={l.id} value={l.id}>{l.catName} › {l.description}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="budget-inline-input"
                            defaultValue={inv.description}
                            onBlur={e => updateInvoiceField(inv.id, 'description', e.target.value)}
                            placeholder="Notes…"
                          />
                        </td>
                        <td className="budget-col-act">
                          {isAdmin && <button className="budget-delete-btn" onClick={() => deleteInvoice(inv.id, inv.vendor)}>✕</button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── CO-PRODUCTION SPLIT ── */}
      <div className="coprod-section">
        <div className="coprod-header">
          <div>
            <div className="coprod-title">Co-production Split</div>
            <div className="coprod-subtitle">Legal entities sharing this production's costs</div>
          </div>
        </div>

        {(() => {
          const totalShare = coprods.reduce((s, r) => s + (parseFloat(r.sharePercent) || 0), 0)
          const shareOk = coprods.length > 0 && Math.abs(totalShare - 100) < 0.01
          return (
            <>
              <div className="budget-table-wrap" style={{ marginBottom: 0 }}>
                <table className="budget-table">
                  <thead>
                    <tr>
                      <th style={{ width: '35%' }}>Legal Entity / Party</th>
                      <th className="budget-col-num" style={{ width: '12%' }}>Share %</th>
                      <th className="budget-col-num" style={{ width: '18%' }}>Est. Amount</th>
                      <th style={{ width: '30%' }}>Notes</th>
                      <th className="budget-col-act"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {coprods.length === 0 ? (
                      <tr><td colSpan={5} style={{ padding: '16px 12px', color: 'var(--text-muted)', fontStyle: 'italic', background: 'var(--surface)', fontSize: 13 }}>No co-producers added.</td></tr>
                    ) : coprods.map(cp => (
                      <tr key={cp.id} className="budget-line-row">
                        <td>
                          <input className="budget-inline-input" defaultValue={cp.name} onBlur={e => saveCoprodField(cp.id, 'name', e.target.value)} readOnly={!isAdmin} />
                        </td>
                        <td>
                          <input className="budget-inline-input budget-num-input" type="number" min="0" max="100" step="any" defaultValue={cp.sharePercent || ''} onBlur={e => saveCoprodField(cp.id, 'sharePercent', e.target.value)} placeholder="0" readOnly={!isAdmin} />
                        </td>
                        <td className="budget-num" style={{ color: 'var(--text-secondary)', paddingRight: 12 }}>
                          {grandBudget > 0 ? fmt((parseFloat(cp.sharePercent) || 0) / 100 * grandBudget) : '—'}
                        </td>
                        <td>
                          <input className="budget-inline-input" defaultValue={cp.notes || ''} onBlur={e => saveCoprodField(cp.id, 'notes', e.target.value)} placeholder="Notes…" readOnly={!isAdmin} />
                        </td>
                        <td className="budget-col-act">
                          {isAdmin && <button className="budget-delete-btn" onClick={() => deleteCoprod(cp.id, cp.name)}>✕</button>}
                        </td>
                      </tr>
                    ))}
                    {coprods.length > 0 && (
                      <tr className="budget-section-total">
                        <td>Total</td>
                        <td className={`budget-num${!shareOk ? ' budget-over' : ' budget-under'}`}>
                          {totalShare.toFixed(1)}%
                          {!shareOk && <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>(should be 100%)</span>}
                        </td>
                        <td className="budget-num">{grandBudget > 0 ? fmt(grandBudget) : '—'}</td>
                        <td colSpan={2}></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {isAdmin && (
                <div className="coprod-add-row">
                  <input
                    className="budget-inline-input"
                    style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--surface-elevated)' }}
                    value={addCoprodName}
                    onChange={e => setAddCoprodName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addCoprod()}
                    placeholder="Add legal entity or party name…"
                  />
                  <button className="btn-secondary" style={{ width: 'auto', padding: '6px 16px', flexShrink: 0 }} onClick={addCoprod} disabled={!addCoprodName.trim()}>
                    Add
                  </button>
                </div>
              )}
            </>
          )
        })()}
      </div>
    </>
  )
}
