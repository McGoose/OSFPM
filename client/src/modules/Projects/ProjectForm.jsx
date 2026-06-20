import { Link } from 'react-router-dom'

const FORMATS = ['Feature Film', 'Short Film', 'Documentary', 'Series', 'Commercial', 'Music Video', 'Other']
const STATUSES = [
  { value: 'development', label: 'Development' },
  { value: 'pre-production', label: 'Pre-Production' },
  { value: 'production', label: 'Production' },
  { value: 'post-production', label: 'Post-Production' },
  { value: 'completed', label: 'Completed' },
]

export default function ProjectForm({ form, onChange, onSubmit, error, saving, mode = 'create', onDelete }) {
  const set = key => e => onChange({ ...form, [key]: e.target.value })

  return (
    <form onSubmit={onSubmit} className="settings-form">
      <section className="settings-section">
        <div className="field">
          <label>Project title</label>
          <input
            type="text"
            value={form.title}
            onChange={set('title')}
            autoFocus
            required
            placeholder="e.g. Midnight Run"
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label>Format</label>
            <select value={form.format} onChange={set('format')}>
              <option value="">— Select format —</option>
              {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Genre</label>
            <input
              type="text"
              value={form.genre}
              onChange={set('genre')}
              placeholder="e.g. Drama, Thriller"
            />
          </div>
        </div>
        <div className="field">
          <label>Status</label>
          <select value={form.status} onChange={set('status')}>
            {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>
            Description{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            value={form.description}
            onChange={set('description')}
            rows={3}
            placeholder="Brief synopsis or notes about this project"
          />
        </div>
      </section>

      {error && <p className="auth-error">{error}</p>}

      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary"
          style={{ width: 'auto', padding: '9px 24px' }}
          disabled={saving}
        >
          {saving ? (mode === 'create' ? 'Creating…' : 'Saving…') : (mode === 'create' ? 'Create project' : 'Save changes')}
        </button>
        <Link to="/projects" style={{ color: 'var(--text-muted)', fontSize: 13 }}>Cancel</Link>
        {mode === 'edit' && onDelete && (
          <button type="button" className="btn-danger" onClick={onDelete}>
            Delete project
          </button>
        )}
      </div>
    </form>
  )
}
