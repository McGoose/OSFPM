import { useState, useEffect, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useProject } from '../../context/ProjectContext'

function api(path, opts) {
  return fetch(path, { credentials: 'include', ...opts })
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')
}

const STATUS_COLORS = { pending: '#d4a017', confirmed: '#6ec071', declined: '#888' }
const TYPE_COLOR = { cast: '#e8a100', crew: '#4da6b3' }

// ── Member list item ──────────────────────────────────────────────────────────

function MemberRow({ member, isSelected, onClick }) {
  return (
    <div
      className={`crew-member-row${isSelected ? ' crew-member-row--active' : ''}`}
      onClick={onClick}
    >
      <div className="crew-avatar" style={{ background: TYPE_COLOR[member.type] ?? '#555' }}>
        {initials(member.name)}
      </div>
      <div className="crew-member-info">
        <div className="crew-member-name">{member.name}</div>
        <div className="crew-member-sub">
          {member.type === 'cast' && member.characterName
            ? <>as <em>{member.characterName}</em></>
            : member.role || <span style={{ color: 'var(--text-muted)' }}>No role set</span>}
        </div>
      </div>
      <div className="crew-member-meta">
        <span
          className="crew-status-dot"
          style={{ background: STATUS_COLORS[member.status] ?? '#555' }}
          title={member.status}
        />
        {member.userId && <span className="crew-account-icon" title="Has OSFPM account">◉</span>}
      </div>
    </div>
  )
}

// ── Field row helper ──────────────────────────────────────────────────────────

function Field({ label, children, half }) {
  return (
    <div className={`field crew-field${half ? ' crew-field--half' : ''}`}>
      <label>{label}</label>
      {children}
    </div>
  )
}

// ── Member detail / edit form ─────────────────────────────────────────────────

function fmtDate(val) {
  if (!val) return ''
  const d = typeof val === 'number' ? new Date(val) : (val instanceof Date ? val : new Date(val))
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function MemberDetail({ member, isAdmin, departments, onPatch, onDelete, onSendLink }) {
  const [fields, setFields] = useState(toFields(member))
  const [sendingLink, setSendingLink] = useState(false)
  const [linkResult, setLinkResult] = useState(null)
  const [linkCopied, setLinkCopied] = useState(false)

  function toFields(m) {
    return {
      type: m.type ?? 'crew',
      name: m.name ?? '',
      email: m.email ?? '',
      phone: m.phone ?? '',
      role: m.role ?? '',
      characterName: m.characterName ?? '',
      departmentId: m.departmentId ? String(m.departmentId) : '',
      pronouns: m.pronouns ?? '',
      dietaryNeeds: m.dietaryNeeds ?? '',
      medicalNeeds: m.medicalNeeds ?? '',
      accessibilityNeeds: m.accessibilityNeeds ?? '',
      agentName: m.agentName ?? '',
      agentEmail: m.agentEmail ?? '',
      agentPhone: m.agentPhone ?? '',
      emergencyName: m.emergencyName ?? '',
      emergencyPhone: m.emergencyPhone ?? '',
      emergencyRelation: m.emergencyRelation ?? '',
      startDate: m.startDate ?? '',
      endDate: m.endDate ?? '',
      status: m.status ?? 'pending',
      notes: m.notes ?? '',
    }
  }

  useEffect(() => { setFields(toFields(member)); setLinkResult(null) }, [member.id])

  const blur = (key) => {
    const val = fields[key]
    const orig = member[key] ?? ''
    if (String(val) !== String(orig)) onPatch(member.id, { [key]: val })
  }

  const changeSelect = (key, val) => {
    setFields(p => ({ ...p, [key]: val }))
    onPatch(member.id, { [key]: val || null })
  }

  const f = (key, type = 'text', placeholder = '') => (
    <input
      type={type}
      value={fields[key]}
      placeholder={placeholder}
      onChange={e => setFields(p => ({ ...p, [key]: e.target.value }))}
      onBlur={() => blur(key)}
    />
  )

  const sendLink = async () => {
    setSendingLink(true)
    const result = await onSendLink(member.id)
    setSendingLink(false)
    if (result) setLinkResult(result)
  }

  const copyLink = () => {
    if (!linkResult?.link) return
    navigator.clipboard.writeText(linkResult.link).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    })
  }

  const tokenActive = member.onboardingTokenExpires && Date.now() < member.onboardingTokenExpires

  const hasAccount = !!member.userId
  const isCast = fields.type === 'cast'

  return (
    <div className="crew-detail-form">
      {/* ── Header ── */}
      <div className="crew-detail-header">
        <div className="crew-avatar crew-avatar--lg" style={{ background: TYPE_COLOR[fields.type] ?? '#555' }}>
          {initials(fields.name || '?')}
        </div>
        <div style={{ flex: 1 }}>
          <div className="crew-detail-name">{member.name}</div>
          <div className="crew-detail-sub">
            {member.type === 'cast' ? (member.characterName ? `as ${member.characterName}` : 'Cast') : member.role || 'Crew'}
          </div>
        </div>
        {isAdmin && (
          <button
            className="btn-danger"
            style={{ alignSelf: 'flex-start', padding: '6px 12px', fontSize: 12 }}
            onClick={() => onDelete(member.id, member.name)}
          >
            Remove
          </button>
        )}
      </div>

      {/* ── Basic info ── */}
      <div className="crew-form-section">
        <div className="crew-form-section-title">Basic Info</div>
        <div className="crew-form-grid">
          <Field label="Full name">
            {f('name', 'text', 'Full name')}
          </Field>
          <Field label="Type">
            <select value={fields.type} onChange={e => changeSelect('type', e.target.value)}>
              <option value="crew">Crew</option>
              <option value="cast">Cast</option>
            </select>
          </Field>
          <Field label="Email">
            {f('email', 'email', 'email@example.com')}
          </Field>
          <Field label="Phone">
            {f('phone', 'tel', '+44 7700 000000')}
          </Field>
        </div>
      </div>

      {/* ── Onboarding link ── */}
      <div className="crew-form-section crew-account-section">
        <div className="crew-form-section-title">Onboarding Link</div>

        <div style={{ marginBottom: 10 }}>
          {member.onboardingCompletedAt ? (
            <p style={{ fontSize: 13, color: '#6ec071', margin: 0 }}>
              ✓ Completed {fmtDate(member.onboardingCompletedAt)}
            </p>
          ) : tokenActive ? (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
              Link active · expires {fmtDate(member.onboardingTokenExpires)}
            </p>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>No link sent yet.</p>
          )}
        </div>

        {linkResult && (
          <div className="ob-link-result" style={{ marginBottom: 10 }}>
            {linkResult.emailSent ? (
              <p style={{ fontSize: 13, color: '#6ec071', marginBottom: 0 }}>
                ✓ Email sent to {member.email}
              </p>
            ) : (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  SMTP not configured — share this link manually:
                </p>
                <div className="ob-link-box">
                  <span className="ob-link-text">{linkResult.link}</span>
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: 11, flexShrink: 0 }}
                    onClick={copyLink}
                  >
                    {linkCopied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <button
          className="btn-secondary"
          style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }}
          onClick={sendLink}
          disabled={sendingLink || !member.email}
          title={!member.email ? 'Email required — add one above' : ''}
        >
          {sendingLink ? 'Generating…' : tokenActive || member.onboardingCompletedAt ? 'Resend link' : 'Send onboarding link'}
        </button>
        {!member.email && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Add an email address to send the link.</p>
        )}
      </div>

      {/* ── Role & assignment ── */}
      <div className="crew-form-section">
        <div className="crew-form-section-title">Role &amp; Assignment</div>
        <div className="crew-form-grid">
          <Field label="Job title / role">
            {f('role', 'text', isCast ? 'Actor' : 'Director of Photography')}
          </Field>
          {isCast ? (
            <Field label="Character name">
              {f('characterName', 'text', 'Character name')}
            </Field>
          ) : (
            <Field label="Department">
              <select
                value={fields.departmentId}
                onChange={e => changeSelect('departmentId', e.target.value)}
              >
                <option value="">— No department —</option>
                {departments.map(d => (
                  <option key={d.id} value={String(d.id)}>{d.icon} {d.name}</option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </div>

      {/* ── Personal & welfare ── */}
      <div className="crew-form-section">
        <div className="crew-form-section-title">Personal &amp; Welfare</div>
        <div className="crew-form-grid">
          <Field label="Pronouns">
            {f('pronouns', 'text', 'e.g. she/her, they/them')}
          </Field>
          <div />
          <Field label="Dietary needs" half={false}>
            <textarea
              rows={2}
              value={fields.dietaryNeeds}
              placeholder="e.g. vegetarian, gluten-free, nut allergy…"
              onChange={e => setFields(p => ({ ...p, dietaryNeeds: e.target.value }))}
              onBlur={() => blur('dietaryNeeds')}
              style={{ resize: 'vertical' }}
            />
          </Field>
          <Field label="Medical needs &amp; allergies" half={false}>
            <textarea
              rows={2}
              value={fields.medicalNeeds}
              placeholder="e.g. carries EpiPen, asthma inhaler, penicillin allergy…"
              onChange={e => setFields(p => ({ ...p, medicalNeeds: e.target.value }))}
              onBlur={() => blur('medicalNeeds')}
              style={{ resize: 'vertical' }}
            />
          </Field>
          <Field label="Accessibility needs" half={false}>
            <textarea
              rows={2}
              value={fields.accessibilityNeeds}
              placeholder="e.g. wheelchair access required, BSL interpreter, large print…"
              onChange={e => setFields(p => ({ ...p, accessibilityNeeds: e.target.value }))}
              onBlur={() => blur('accessibilityNeeds')}
              style={{ resize: 'vertical' }}
            />
          </Field>
        </div>
      </div>

      {/* ── Availability & status ── */}
      <div className="crew-form-section">
        <div className="crew-form-section-title">Availability &amp; Status</div>
        <div className="crew-form-grid">
          <Field label="Start date">
            {f('startDate', 'date')}
          </Field>
          <Field label="End date">
            {f('endDate', 'date')}
          </Field>
          <Field label="Onboarding status">
            <select value={fields.status} onChange={e => changeSelect('status', e.target.value)}>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="declined">Declined</option>
            </select>
          </Field>
        </div>
      </div>

      {/* ── Emergency contact ── */}
      <div className="crew-form-section">
        <div className="crew-form-section-title">Emergency Contact</div>
        <div className="crew-form-grid">
          <Field label="Name">
            {f('emergencyName', 'text', 'Contact name')}
          </Field>
          <Field label="Phone">
            {f('emergencyPhone', 'tel', 'Phone number')}
          </Field>
          <Field label="Relationship">
            {f('emergencyRelation', 'text', 'e.g. Spouse, Parent')}
          </Field>
        </div>
      </div>

      {/* ── Agent (cast only) ── */}
      {isCast && (
        <div className="crew-form-section">
          <div className="crew-form-section-title">Agent / Representative</div>
          <div className="crew-form-grid">
            <Field label="Name">
              {f('agentName', 'text', 'Agent name')}
            </Field>
            <Field label="Email">
              {f('agentEmail', 'email', 'agent@agency.com')}
            </Field>
            <Field label="Phone">
              {f('agentPhone', 'tel', 'Agent phone')}
            </Field>
          </div>
        </div>
      )}

      {/* ── Notes ── */}
      <div className="crew-form-section">
        <div className="crew-form-section-title">Notes</div>
        <div className="field" style={{ marginBottom: 0 }}>
          <textarea
            rows={3}
            value={fields.notes}
            placeholder="Any additional notes…"
            onChange={e => setFields(p => ({ ...p, notes: e.target.value }))}
            onBlur={() => blur('notes')}
            style={{ resize: 'vertical' }}
          />
        </div>
      </div>

      {/* ── OSFPM account status (read-only — account created via onboarding link) ── */}
      {isAdmin && (
        <div className="crew-form-section crew-account-section">
          <div className="crew-form-section-title">OSFPM Account</div>
          {member.userId ? (
            <span className="crew-account-badge">◉ Account active — user can log in to OSFPM</span>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
              No account yet. The user will create one when they complete their onboarding link above.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Add member form ────────────────────────────────────────────────────────────

function AddMemberForm({ departments, onCreate, onCancel }) {
  const [fields, setFields] = useState({
    type: 'crew', name: '', email: '', phone: '', role: '',
    characterName: '', departmentId: '', status: 'pending',
    pronouns: '', dietaryNeeds: '', medicalNeeds: '', accessibilityNeeds: '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!fields.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError('')
    const ok = await onCreate(fields)
    if (!ok) setError('Failed to create member')
    setSaving(false)
  }

  const isCast = fields.type === 'cast'
  const set = (k, v) => setFields(p => ({ ...p, [k]: v }))

  return (
    <form className="crew-detail-form" onSubmit={submit}>
      <div className="crew-detail-header">
        <div className="crew-avatar crew-avatar--lg" style={{ background: TYPE_COLOR[fields.type] ?? '#555' }}>
          {fields.name ? initials(fields.name) : '+'}
        </div>
        <div>
          <div className="crew-detail-name" style={{ color: fields.name ? undefined : 'var(--text-muted)' }}>
            {fields.name || 'New member'}
          </div>
          <div className="crew-detail-sub">{isCast ? 'Cast' : 'Crew'}</div>
        </div>
      </div>

      <div className="crew-form-section">
        <div className="crew-form-section-title">Basic Info</div>
        <div className="crew-form-grid">
          <Field label="Full name *">
            <input value={fields.name} onChange={e => set('name', e.target.value)} placeholder="Full name" autoFocus />
          </Field>
          <Field label="Type">
            <select value={fields.type} onChange={e => set('type', e.target.value)}>
              <option value="crew">Crew</option>
              <option value="cast">Cast</option>
            </select>
          </Field>
          <Field label="Email">
            <input type="email" value={fields.email} onChange={e => set('email', e.target.value)} placeholder="email@example.com" />
          </Field>
          <Field label="Phone">
            <input type="tel" value={fields.phone} onChange={e => set('phone', e.target.value)} placeholder="+44 7700 000000" />
          </Field>
        </div>
      </div>

      <div className="crew-form-section">
        <div className="crew-form-section-title">Role &amp; Assignment</div>
        <div className="crew-form-grid">
          <Field label="Job title / role">
            <input value={fields.role} onChange={e => set('role', e.target.value)} placeholder={isCast ? 'Actor' : 'Director of Photography'} />
          </Field>
          {isCast ? (
            <Field label="Character name">
              <input value={fields.characterName} onChange={e => set('characterName', e.target.value)} placeholder="Character name" />
            </Field>
          ) : (
            <Field label="Department">
              <select value={fields.departmentId} onChange={e => set('departmentId', e.target.value)}>
                <option value="">— No department —</option>
                {departments.map(d => (
                  <option key={d.id} value={String(d.id)}>{d.icon} {d.name}</option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </div>

      <div className="crew-form-section">
        <div className="crew-form-section-title">Personal &amp; Welfare</div>
        <div className="crew-form-grid">
          <Field label="Pronouns">
            <input value={fields.pronouns} onChange={e => set('pronouns', e.target.value)} placeholder="e.g. she/her, they/them" />
          </Field>
          <div />
          <Field label="Dietary needs">
            <textarea
              rows={2}
              value={fields.dietaryNeeds}
              onChange={e => set('dietaryNeeds', e.target.value)}
              placeholder="e.g. vegetarian, nut allergy…"
              style={{ resize: 'vertical' }}
            />
          </Field>
          <Field label="Medical needs &amp; allergies">
            <textarea
              rows={2}
              value={fields.medicalNeeds}
              onChange={e => set('medicalNeeds', e.target.value)}
              placeholder="e.g. carries EpiPen, penicillin allergy…"
              style={{ resize: 'vertical' }}
            />
          </Field>
          <Field label="Accessibility needs">
            <textarea
              rows={2}
              value={fields.accessibilityNeeds}
              onChange={e => set('accessibilityNeeds', e.target.value)}
              placeholder="e.g. wheelchair access, BSL interpreter…"
              style={{ resize: 'vertical' }}
            />
          </Field>
        </div>
      </div>

      <div className="crew-form-section">
        <div className="crew-form-section-title">Status</div>
        <div className="crew-form-grid">
          <Field label="Onboarding status">
            <select value={fields.status} onChange={e => set('status', e.target.value)}>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="declined">Declined</option>
            </select>
          </Field>
        </div>
      </div>

      {error && <p className="auth-error" style={{ marginTop: 8 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button type="submit" className="btn-primary" style={{ width: 'auto', padding: '9px 20px' }} disabled={saving}>
          {saving ? 'Creating…' : 'Create member'}
        </button>
        <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '9px 14px' }} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── Main Crew page ─────────────────────────────────────────────────────────────

export default function Crew() {
  const { id } = useParams()
  const { departments } = useProject()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [members, setMembers] = useState([])
  const [selectedId, setSelectedId] = useState(null) // null | 'new' | number
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const res = await api(`/api/projects/${id}/crew`)
    if (res.ok) setMembers(await res.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [id])

  // ── Filtered list ──────────────────────────────────────────────────────────

  const filtered = members
    .filter(m => typeFilter === 'all' || m.type === typeFilter)
    .filter(m => statusFilter === 'all' || m.status === statusFilter)
    .filter(m => !search.trim() || m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.role?.toLowerCase().includes(search.toLowerCase()) ||
      m.characterName?.toLowerCase().includes(search.toLowerCase()))

  const selected = typeof selectedId === 'number' ? members.find(m => m.id === selectedId) : null

  const counts = {
    all: members.length,
    cast: members.filter(m => m.type === 'cast').length,
    crew: members.filter(m => m.type === 'crew').length,
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  const createMember = async (fields) => {
    const res = await api(`/api/projects/${id}/crew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
    if (!res.ok) return false
    const member = await res.json()
    setMembers(prev => [...prev, member])
    setSelectedId(member.id)
    return true
  }

  const patchMember = useCallback(async (memberId, updates) => {
    const res = await api(`/api/projects/${id}/crew/${memberId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) return
    const updated = await res.json()
    setMembers(prev => prev.map(m => m.id === memberId ? updated : m))
  }, [id])

  const deleteMember = useCallback(async (memberId, name) => {
    if (!confirm(`Remove ${name} from this project?`)) return
    await api(`/api/projects/${id}/crew/${memberId}`, { method: 'DELETE' })
    setMembers(prev => prev.filter(m => m.id !== memberId))
    if (selectedId === memberId) setSelectedId(null)
  }, [id, selectedId])

  const sendOnboardingLink = useCallback(async (memberId) => {
    const res = await api(`/api/projects/${id}/crew/${memberId}/onboarding-link`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { alert(data.error); return null }
    if (data.member) setMembers(prev => prev.map(m => m.id === memberId ? data.member : m))
    return { link: data.link, emailSent: data.emailSent }
  }, [id])


  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="empty-state"><p>Loading…</p></div>

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← Overview</Link>
        <div className="page-header-row" style={{ marginTop: 8 }}>
          <div>
            <h1>Crew &amp; Cast</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
              {members.length} member{members.length !== 1 ? 's' : ''}
              {members.filter(m => m.userId).length > 0 && ` · ${members.filter(m => m.userId).length} with accounts`}
            </p>
          </div>
          {isAdmin && (
            <button
              className="btn-primary"
              style={{ width: 'auto', padding: '8px 16px' }}
              onClick={() => setSelectedId(selectedId === 'new' ? null : 'new')}
            >
              {selectedId === 'new' ? 'Cancel' : '+ Add member'}
            </button>
          )}
        </div>
      </div>

      <div className="crew-layout">
        {/* ── List panel ── */}
        <div className="crew-list-panel">
          <div className="crew-list-search">
            <input
              placeholder="Search by name or role…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Type tabs */}
          <div className="crew-type-tabs">
            {[
              { key: 'all', label: `All (${counts.all})` },
              { key: 'crew', label: `Crew (${counts.crew})` },
              { key: 'cast', label: `Cast (${counts.cast})` },
            ].map(t => (
              <button
                key={t.key}
                className={`crew-type-tab${typeFilter === t.key ? ' crew-type-tab--active' : ''}`}
                onClick={() => setTypeFilter(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <div className="crew-status-filter">
            {['all', 'pending', 'confirmed', 'declined'].map(s => (
              <button
                key={s}
                className={`inv-filter-btn${statusFilter === s ? ' inv-filter-btn--active' : ''}`}
                onClick={() => setStatusFilter(s)}
              >
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          {/* Member list */}
          <div className="crew-member-list">
            {filtered.length === 0 ? (
              <p style={{ padding: '20px 16px', color: 'var(--text-muted)', fontSize: 13 }}>
                {members.length === 0 ? 'No members yet.' : 'No matches.'}
              </p>
            ) : (
              filtered.map(m => (
                <MemberRow
                  key={m.id}
                  member={m}
                  isSelected={selectedId === m.id}
                  onClick={() => setSelectedId(m.id === selectedId ? null : m.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Detail panel ── */}
        <div className="crew-detail-panel">
          {selectedId === 'new' ? (
            <AddMemberForm
              departments={departments}
              onCreate={createMember}
              onCancel={() => setSelectedId(null)}
            />
          ) : selected ? (
            <MemberDetail
              key={selected.id}
              member={selected}
              isAdmin={isAdmin}
              departments={departments}
              onPatch={patchMember}
              onDelete={deleteMember}
              onSendLink={sendOnboardingLink}
            />
          ) : (
            <div className="empty-state" style={{ padding: '60px 20px' }}>
              <div className="empty-state-icon">👥</div>
              <p>Select a member to view their profile{isAdmin ? ', or add a new one.' : '.'}</p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
