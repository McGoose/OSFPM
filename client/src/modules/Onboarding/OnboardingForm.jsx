import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'

function Section({ title, children }) {
  return (
    <div className="ob-section">
      <div className="ob-section-title">{title}</div>
      {children}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="ob-field">
      <label>{label}</label>
      {children}
    </div>
  )
}

function Row({ children }) {
  return <div className="ob-row">{children}</div>
}

export default function OnboardingForm() {
  const { token } = useParams()

  const [state, setState] = useState('loading') // loading | form | success | error
  const [errorMsg, setErrorMsg] = useState('')
  const [project, setProject] = useState(null)
  const [member, setMember] = useState(null)
  const [hasAccount, setHasAccount] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [fields, setFields] = useState({
    name: '',
    phone: '',
    pronouns: '',
    dietaryNeeds: '',
    medicalNeeds: '',
    accessibilityNeeds: '',
    emergencyName: '',
    emergencyPhone: '',
    emergencyRelation: '',
    agentName: '',
    agentEmail: '',
    agentPhone: '',
  })
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')

  useEffect(() => {
    fetch(`/api/onboarding/${token}`)
      .then(async r => {
        const data = await r.json()
        if (!r.ok) { setErrorMsg(data.error); setState('error'); return }
        setProject(data.project)
        setMember(data.member)
        setHasAccount(data.member.hasAccount ?? false)
        setFields({
          name: data.member.name ?? '',
          phone: data.member.phone ?? '',
          pronouns: data.member.pronouns ?? '',
          dietaryNeeds: data.member.dietaryNeeds ?? '',
          medicalNeeds: data.member.medicalNeeds ?? '',
          accessibilityNeeds: data.member.accessibilityNeeds ?? '',
          emergencyName: data.member.emergencyName ?? '',
          emergencyPhone: data.member.emergencyPhone ?? '',
          emergencyRelation: data.member.emergencyRelation ?? '',
          agentName: data.member.agentName ?? '',
          agentEmail: data.member.agentEmail ?? '',
          agentPhone: data.member.agentPhone ?? '',
        })
        setState('form')
      })
      .catch(() => { setErrorMsg('Could not connect to the server.'); setState('error') })
  }, [token])

  const set = (k, v) => setFields(p => ({ ...p, [k]: v }))
  const inp = (key, type = 'text', placeholder = '') => (
    <input
      type={type}
      value={fields[key]}
      placeholder={placeholder}
      onChange={e => set(key, e.target.value)}
    />
  )
  const ta = (key, placeholder = '') => (
    <textarea
      rows={3}
      value={fields[key]}
      placeholder={placeholder}
      onChange={e => set(key, e.target.value)}
      style={{ resize: 'vertical' }}
    />
  )

  const submit = async (e) => {
    e.preventDefault()
    if (!fields.name.trim()) return

    // Validate password
    setPasswordError('')
    if (!hasAccount && !password) {
      setPasswordError('Please choose a password to create your account.')
      return
    }
    if (password) {
      if (password.length < 8) {
        setPasswordError('Password must be at least 8 characters.')
        return
      }
      if (password !== confirmPassword) {
        setPasswordError('Passwords do not match.')
        return
      }
    }

    setSubmitting(true)
    const body = { ...fields }
    if (password) body.password = password

    const res = await fetch(`/api/onboarding/${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSubmitting(false)
    if (res.ok) {
      setState('success')
    } else {
      const d = await res.json()
      setPasswordError(d.error ?? 'Something went wrong.')
    }
  }

  const displayRole = member
    ? member.type === 'cast'
      ? (member.characterName ? `${member.role || 'Cast'} — ${member.characterName}` : member.role || 'Cast')
      : (member.role || 'Crew')
    : ''

  if (state === 'loading') {
    return (
      <div className="ob-page">
        <div className="ob-card">
          <p className="ob-loading">Loading your onboarding form…</p>
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="ob-page">
        <div className="ob-card">
          <div className="ob-wordmark">OSFPM</div>
          <h1 className="ob-title" style={{ color: '#e05a5a' }}>Link invalid</h1>
          <p className="ob-subtitle">{errorMsg}</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
            If you believe this is a mistake, contact your production team and ask them to resend the onboarding link.
          </p>
        </div>
      </div>
    )
  }

  if (state === 'success') {
    return (
      <div className="ob-page">
        <div className="ob-card">
          <div className="ob-wordmark">OSFPM</div>
          <div className="ob-success-icon">✓</div>
          <h1 className="ob-title">All done!</h1>
          <p className="ob-subtitle">
            Your information has been submitted to the {project?.title ?? 'production'} team.
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
            You can close this tab. If anything changes (dietary needs, emergency contacts, etc.) contact your production coordinator.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ob-page">
      <div className="ob-card">
        <div className="ob-wordmark">OSFPM</div>

        <div className="ob-header">
          <h1 className="ob-title">Welcome, {member?.name?.split(' ')[0]}</h1>
          {project && (
            <p className="ob-subtitle">
              You've been added to <strong>{project.title}</strong> as <strong>{displayRole}</strong>.
            </p>
          )}
          <p className="ob-intro">
            Please fill out the form below. This information helps the production team with scheduling, safety, and catering.
            All fields are optional except your name.
          </p>
        </div>

        <form onSubmit={submit}>

          <Section title="Contact details">
            <Row>
              <Field label="Full name *">{inp('name', 'text', 'Your full name')}</Field>
              <Field label="Phone number">{inp('phone', 'tel', '+44 7700 000000')}</Field>
            </Row>
            <Row>
              <Field label="Pronouns">{inp('pronouns', 'text', 'e.g. she/her, they/them, he/him')}</Field>
            </Row>
          </Section>

          <Section title="Dietary &amp; medical">
            <Field label="Dietary needs">
              {ta('dietaryNeeds', 'e.g. vegetarian, vegan, gluten-free, nut allergy, halal, kosher…')}
            </Field>
            <Field label="Medical needs &amp; allergies">
              {ta('medicalNeeds', 'e.g. carries EpiPen, asthma inhaler, penicillin allergy, diabetes…')}
            </Field>
          </Section>

          <Section title="Accessibility">
            <Field label="Accessibility needs">
              {ta('accessibilityNeeds', 'e.g. wheelchair access required, BSL interpreter, large-print documents, hearing loop…')}
            </Field>
          </Section>

          <Section title="Emergency contact">
            <Row>
              <Field label="Name">{inp('emergencyName', 'text', 'Emergency contact name')}</Field>
              <Field label="Phone">{inp('emergencyPhone', 'tel', 'Their phone number')}</Field>
            </Row>
            <Row>
              <Field label="Relationship">{inp('emergencyRelation', 'text', 'e.g. Spouse, Parent, Sibling')}</Field>
            </Row>
          </Section>

          {member?.type === 'cast' && (
            <Section title="Agent / representative">
              <Row>
                <Field label="Agent name">{inp('agentName', 'text', 'Agent or manager name')}</Field>
                <Field label="Agent phone">{inp('agentPhone', 'tel', 'Agent phone number')}</Field>
              </Row>
              <Row>
                <Field label="Agent email">{inp('agentEmail', 'email', 'agent@agency.com')}</Field>
              </Row>
            </Section>
          )}

          <Section title={hasAccount ? 'Reset your password' : 'Create your OSFPM account'}>
            {member?.email && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
                {hasAccount
                  ? <>You already have an account. Leave the password fields blank to keep your current password, or enter a new one to change it.</>
                  : <>Your account will be created with the email <strong style={{ color: 'var(--text-secondary)' }}>{member.email}</strong>. You'll use these credentials to log in to OSFPM.</>}
              </p>
            )}
            <Row>
              <Field label={hasAccount ? 'New password' : 'Password *'}>
                <input
                  type="password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setPasswordError('') }}
                  placeholder="Minimum 8 characters"
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm password">
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => { setConfirmPassword(e.target.value); setPasswordError('') }}
                  placeholder="Repeat your password"
                  autoComplete="new-password"
                />
              </Field>
            </Row>
            {passwordError && (
              <p style={{ color: '#e05a5a', fontSize: 13, marginTop: 4 }}>{passwordError}</p>
            )}
          </Section>

          <div className="ob-actions">
            <button type="submit" className="ob-submit" disabled={submitting || !fields.name.trim()}>
              {submitting ? 'Submitting…' : hasAccount ? 'Update my details' : 'Create account & submit'}
            </button>
            <p className="ob-note">
              Your information is stored securely and only accessible to the production team.
            </p>
          </div>

        </form>
      </div>
    </div>
  )
}
