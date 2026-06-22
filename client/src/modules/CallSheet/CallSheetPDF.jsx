import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

// ── Styles ────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 7, padding: '10mm', backgroundColor: '#fff', color: '#000' },

  // Layout
  row:        { flexDirection: 'row' },
  col:        { flex: 1 },
  bold:       { fontFamily: 'Helvetica-Bold' },
  italic:     { fontFamily: 'Helvetica-Oblique' },
  caps:       { textTransform: 'uppercase' },
  center:     { textAlign: 'center' },
  right:      { textAlign: 'right' },

  // Borders
  border:     { border: '0.5pt solid #000' },
  borderB:    { borderBottom: '0.5pt solid #000' },
  borderT:    { borderTop: '0.5pt solid #000' },
  borderR:    { borderRight: '0.5pt solid #000' },
  borderL:    { borderLeft: '0.5pt solid #000' },

  // Common cells
  cell:       { padding: '1.5pt 3pt', border: '0.5pt solid #000' },
  cellNB:     { padding: '1.5pt 3pt' },
  hdrCell:    { padding: '1.5pt 3pt', border: '0.5pt solid #000', fontFamily: 'Helvetica-Bold', fontSize: 6.5, textTransform: 'uppercase', backgroundColor: '#e8e8e8' },

  // Spacer
  spacer:     { height: '3pt' },
  spacerSm:   { height: '1.5pt' },

  // Page 1 header
  p1Title:    { fontSize: 14, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', textAlign: 'center' },
  p1Sub:      { fontSize: 8, textAlign: 'center' },
  bigTime:    { fontSize: 22, fontFamily: 'Helvetica-Bold', textAlign: 'center' },
  keyLabel:   { fontSize: 6, textTransform: 'uppercase', color: '#555' },
  keyValue:   { fontSize: 9, fontFamily: 'Helvetica-Bold' },

  // Section labels
  sectionLbl: { fontSize: 6.5, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', backgroundColor: '#ddd', padding: '2pt 3pt', borderBottom: '0.5pt solid #000', borderTop: '0.5pt solid #000' },

  // Page 2
  p2Title:    { fontSize: 16, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase' },
  deptHdr:    { fontSize: 6.5, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', backgroundColor: '#ddd', padding: '1.5pt 3pt', borderBottom: '0.5pt solid #000' },
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMins(t) {
  if (!t) return 0
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
function fmtMins(m) {
  if (m === null || m === undefined || isNaN(m)) return '—'
  const h = Math.floor(((m % 1440) + 1440) % 1440 / 60)
  const min = ((m % 1440) + 1440) % 1440 % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function calcCastTimes(row, shootCall) {
  const shootMins = parseMins(shootCall || '10:00')
  const hmuStart  = shootMins - (row.hmuMins || 0)
  const blocking  = hmuStart - (row.blockingMins || 0)
  const arrival   = blocking - 5
  const pickup    = row.pickupTime || fmtMins(arrival - 15)
  return {
    pickup:   row.pickupTime || fmtMins(arrival - 15),
    arrival:  fmtMins(arrival),
    blocking: fmtMins(blocking),
    hmu:      fmtMins(hmuStart),
    set:      shootCall || '—',
  }
}

function fmtDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr + 'T00:00').toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// ── Reusable components ───────────────────────────────────────────────────────

function TRow({ children, style }) {
  return <View style={[S.row, style]}>{children}</View>
}

function TCell({ children, flex, style, bold, center, right, hdr }) {
  const base = hdr ? S.hdrCell : S.cell
  const extra = []
  if (bold) extra.push(S.bold)
  if (center) extra.push(S.center)
  if (right) extra.push(S.right)
  return (
    <View style={[base, { flex: flex ?? 1 }, ...(style ? [style] : [])]}>
      <Text style={extra}>{children ?? ''}</Text>
    </View>
  )
}

function SectionLabel({ children }) {
  return <View style={S.sectionLbl}><Text>{children}</Text></View>
}

// ── Page 1 ───────────────────────────────────────────────────────────────────

function SceneTable({ event, allScenes }) {
  const sceneIds = event.sceneIds ?? []
  const rows = sceneIds.map(id => allScenes.find(s => s.id === id)).filter(Boolean)
  if (rows.length === 0) return null
  return (
    <View>
      <SectionLabel>Scenes</SectionLabel>
      <TRow>
        <TCell flex={0.4} hdr>Scene</TCell>
        <TCell flex={3} hdr>Set &amp; Description</TCell>
        <TCell flex={1} hdr>Cast</TCell>
        <TCell flex={0.6} hdr>D/N</TCell>
        <TCell flex={0.6} hdr>Pages</TCell>
        <TCell flex={2} hdr>Location</TCell>
      </TRow>
      {rows.map(s => (
        <TRow key={s.id}>
          <TCell flex={0.4}>{s.sceneNumber}</TCell>
          <TCell flex={3}>{s.intExt}. {s.location}{s.description ? ` — ${s.description}` : ''}</TCell>
          <TCell flex={1}>—</TCell>
          <TCell flex={0.6}>{s.timeOfDay?.slice(0, 1) ?? 'D'}</TCell>
          <TCell flex={0.6}>{s.pages ? `${s.pages}/8` : '—'}</TCell>
          <TCell flex={2}>{s.location}</TCell>
        </TRow>
      ))}
      <View style={S.spacer} />
    </View>
  )
}

function CastTable({ castRows, shootCall }) {
  if (!castRows?.length) return null
  return (
    <View>
      <SectionLabel>Cast</SectionLabel>
      <TRow>
        <TCell flex={0.3} hdr>ID</TCell>
        <TCell flex={1.5} hdr>Actor</TCell>
        <TCell flex={1.5} hdr>Character</TCell>
        <TCell flex={0.5} hdr>Status</TCell>
        <TCell flex={0.6} hdr>Pickup</TCell>
        <TCell flex={0.6} hdr>Arrival</TCell>
        <TCell flex={0.6} hdr>Blocking</TCell>
        <TCell flex={0.6} hdr>H/MU</TCell>
        <TCell flex={0.6} hdr>Set</TCell>
        <TCell flex={2} hdr>Notes</TCell>
      </TRow>
      {castRows.map((row, i) => {
        const t = calcCastTimes(row, shootCall)
        return (
          <TRow key={i}>
            <TCell flex={0.3}>{i + 1}</TCell>
            <TCell flex={1.5}>{row.name}</TCell>
            <TCell flex={1.5}>{row.character}</TCell>
            <TCell flex={0.5}>{row.status}</TCell>
            <TCell flex={0.6}>{t.pickup}</TCell>
            <TCell flex={0.6}>{t.arrival}</TCell>
            <TCell flex={0.6}>{t.blocking}</TCell>
            <TCell flex={0.6}>{t.hmu}</TCell>
            <TCell flex={0.6}>{t.set}</TCell>
            <TCell flex={2}>{row.notes}</TCell>
          </TRow>
        )
      })}
      <View style={S.spacer} />
    </View>
  )
}

function ExtrasAndInstructions({ extras, specialInstructions }) {
  const depts = [
    ['Art Dept',      specialInstructions?.artDept],
    ['Props',         specialInstructions?.props],
    ['Make-up',       specialInstructions?.makeup],
    ['Costumes',      specialInstructions?.costumes],
    ['SFX',           specialInstructions?.sfx],
    ['Camera',        specialInstructions?.camera],
    ['Grip/Electric', specialInstructions?.gripElectric],
    ['Sound',         specialInstructions?.sound],
    ['Locations',     specialInstructions?.locations],
    ['Vehicles',      specialInstructions?.vehicles],
    ['Stunts',        specialInstructions?.stunts],
    ['Animals',       specialInstructions?.animals],
  ].filter(([, v]) => v)

  return (
    <TRow>
      {/* Extras */}
      <View style={{ flex: 1, marginRight: '4pt' }}>
        <SectionLabel>Background / Extras</SectionLabel>
        <TRow>
          <TCell flex={0.5} hdr>#</TCell>
          <TCell flex={3} hdr>Description</TCell>
          <TCell flex={0.8} hdr>Arrival</TCell>
          <TCell flex={0.8} hdr>On set</TCell>
          <TCell flex={0.8} hdr>Scenes</TCell>
        </TRow>
        {(extras ?? []).filter(e => e.description).map((e, i) => (
          <TRow key={i}>
            <TCell flex={0.5}>{e.count}</TCell>
            <TCell flex={3}>{e.description}</TCell>
            <TCell flex={0.8}>{e.arrival}</TCell>
            <TCell flex={0.8}>{e.onSet}</TCell>
            <TCell flex={0.8}>{e.scenes}</TCell>
          </TRow>
        ))}
        {(!extras?.length || !extras.some(e => e.description)) && (
          <TRow><TCell flex={1} style={{ color: '#aaa' }}>—</TCell></TRow>
        )}
      </View>
      {/* Special Instructions */}
      <View style={{ flex: 1, border: '0.5pt solid #000', padding: '2pt 3pt' }}>
        <Text style={[S.bold, S.caps, { fontSize: 6.5, marginBottom: '2pt' }]}>Special Instructions</Text>
        {depts.map(([label, val]) => (
          <View key={label} style={{ marginBottom: '2pt' }}>
            <Text style={S.bold}>{label.toUpperCase()}:</Text>
            <Text>{val}</Text>
          </View>
        ))}
        {depts.length === 0 && <Text style={{ color: '#aaa' }}>—</Text>}
      </View>
    </TRow>
  )
}

function AdvanceSchedule({ advanceSceneIds, allScenes }) {
  const rows = (advanceSceneIds ?? []).map(id => allScenes.find(s => s.id === id)).filter(Boolean)
  if (!rows.length) return null
  return (
    <View style={{ marginTop: '4pt' }}>
      <SectionLabel>Advance Schedule</SectionLabel>
      <TRow>
        <TCell flex={0.4} hdr>Scene</TCell>
        <TCell flex={3} hdr>Set &amp; Description</TCell>
        <TCell flex={0.6} hdr>D/N</TCell>
        <TCell flex={0.6} hdr>Pages</TCell>
        <TCell flex={2} hdr>Location</TCell>
      </TRow>
      {rows.map(s => (
        <TRow key={s.id}>
          <TCell flex={0.4}>{s.sceneNumber}</TCell>
          <TCell flex={3}>{s.intExt}. {s.location}{s.description ? ` — ${s.description}` : ''}</TCell>
          <TCell flex={0.6}>{s.timeOfDay?.slice(0, 1) ?? 'D'}</TCell>
          <TCell flex={0.6}>{s.pages ? `${s.pages}/8` : '—'}</TCell>
          <TCell flex={2}>{s.location}</TCell>
        </TRow>
      ))}
    </View>
  )
}

// ── Page 2 ───────────────────────────────────────────────────────────────────

function DeptCallBlock({ title, members, defaultCall, override }) {
  const callTime = override || defaultCall || '—'
  return (
    <View style={{ marginBottom: '4pt' }}>
      <View style={S.deptHdr}>
        <Text style={S.bold}>{title}</Text>
      </View>
      {members.length === 0 ? (
        <TRow>
          <View style={[S.cell, { flex: 1 }]}><Text style={{ color: '#aaa' }}>—</Text></View>
          <View style={[S.cell, { flex: 0.6 }]}><Text>{callTime}</Text></View>
        </TRow>
      ) : members.map((m, i) => (
        <TRow key={i}>
          <View style={[S.cell, { flex: 0.3 }]}><Text>{i + 1}</Text></View>
          <View style={[S.cell, { flex: 2 }]}><Text>{m.name}</Text></View>
          <View style={[S.cell, { flex: 1.5 }]}><Text>{m.role}</Text></View>
          <View style={[S.cell, { flex: 0.6 }]}><Text style={S.bold}>{callTime}</Text></View>
        </TRow>
      ))}
    </View>
  )
}

// ── Main document ─────────────────────────────────────────────────────────────

export default function CallSheetPDF({ data, event, crew, allScenes, projectTitle, orgName }) {
  const d = data || {}
  const overrides = d.crewCallOverrides || {}

  // Extract key people from crew by role (case-insensitive partial match)
  const findByRole = (role) => crew.find(m => m.role?.toLowerCase().includes(role.toLowerCase()))
  const producer = findByRole('producer')
  const director = findByRole('director')
  const firstAD  = crew.find(m => m.role?.toLowerCase().includes('1st ad') || m.role?.toLowerCase().includes('1st assistant director'))
  const secondAD = crew.find(m => m.role?.toLowerCase().includes('2nd ad') || m.role?.toLowerCase().includes('2nd assistant director'))

  // Group crew by department for page 2
  const byDept = {}
  for (const m of crew) {
    const key = m.departmentId ?? 'none'
    if (!byDept[key]) byDept[key] = []
    byDept[key].push(m)
  }

  const shootCallMins = parseMins(d.shootCall || event?.startTime || '10:00')
  const crewCallDisplay = d.crewCall || event?.startTime || '—'

  return (
    <Document>
      {/* ── PAGE 1 ── */}
      <Page size="A4" style={S.page}>

        {/* Header */}
        <TRow style={{ marginBottom: '4pt', alignItems: 'stretch' }}>
          <View style={{ flex: 1, border: '0.5pt solid #000', padding: '3pt' }}>
            <Text style={[S.bold, { fontSize: 7 }]}>{orgName || 'Production Company'}</Text>
            <Text style={{ fontSize: 6, color: '#555', marginTop: '2pt' }}>
              {event?.location || ''}
            </Text>
          </View>
          <View style={{ flex: 2, border: '0.5pt solid #000', padding: '3pt', alignItems: 'center' }}>
            <Text style={S.p1Title}>{projectTitle || 'PRODUCTION TITLE'}</Text>
            <Text style={[S.bold, { fontSize: 10 }]}>CALL SHEET</Text>
          </View>
          <View style={{ flex: 1, border: '0.5pt solid #000', padding: '3pt' }}>
            <Text style={S.keyLabel}>Date</Text>
            <Text style={S.keyValue}>{fmtDate(event?.date)}</Text>
            <View style={{ marginTop: '4pt' }}>
              <Text style={S.keyLabel}>Day</Text>
              <Text style={S.keyValue}>{d.dayNumber ?? 1} of {d.totalDays ?? '?'}</Text>
            </View>
          </View>
        </TRow>

        {/* Key times */}
        <TRow style={{ border: '0.5pt solid #000', marginBottom: '2pt' }}>
          <View style={{ flex: 2, borderRight: '0.5pt solid #000', padding: '4pt', alignItems: 'center' }}>
            <Text style={S.keyLabel}>Crew Call</Text>
            <Text style={[S.bigTime]}>{crewCallDisplay}</Text>
          </View>
          <View style={{ flex: 1 }}>
            {[
              ['Breakfast', d.breakfast],
              ['Shoot', d.shootCall || event?.startTime],
              ['1st Meal', d.meal1 ? `${d.meal1}${d.meal1End ? ` to ${d.meal1End}` : ''}` : null],
              ['Wrap', d.wrap || event?.endTime],
            ].map(([lbl, val]) => val ? (
              <TRow key={lbl} style={{ borderBottom: '0.5pt solid #000', padding: '2pt 4pt' }}>
                <Text style={[S.keyLabel, { flex: 1 }]}>{lbl.toUpperCase()}</Text>
                <Text style={[S.keyValue, { fontSize: 8 }]}>{val}</Text>
              </TRow>
            ) : null)}
          </View>
          <View style={{ flex: 1, borderLeft: '0.5pt solid #000', padding: '4pt' }}>
            {[
              ['Producer',  producer?.name],
              ['Director',  director?.name],
              ['1st AD',    firstAD?.name],
              ['2nd AD',    secondAD?.name],
              ['Set Medic', d.setMedicName ? `${d.setMedicName}${d.setMedicPhone ? ` · ${d.setMedicPhone}` : ''}` : null],
            ].map(([lbl, val]) => val ? (
              <View key={lbl} style={{ marginBottom: '2pt' }}>
                <Text style={S.keyLabel}>{lbl}</Text>
                <Text style={{ fontSize: 7 }}>{val}</Text>
              </View>
            ) : null)}
          </View>
        </TRow>

        {/* Info bar */}
        <TRow style={{ border: '0.5pt solid #000', marginBottom: '4pt', fontSize: 6.5 }}>
          <View style={{ flex: 1, padding: '2pt 4pt', borderRight: '0.5pt solid #000' }}>
            {d.scriptVersion   && <Text>Script v{d.scriptVersion}  ·  Schedule v{d.scheduleVersion || '—'}</Text>}
            {d.catering        && <Text>Catering: {d.catering}</Text>}
          </View>
          <View style={{ flex: 1, padding: '2pt 4pt', borderRight: '0.5pt solid #000' }}>
            {(d.tempHigh || d.tempLow) && <Text>High: {d.tempHigh}°c  ·  Low: {d.tempLow}°c</Text>}
            {(d.sunrise || d.sunset)   && <Text>Sunrise: {d.sunrise || '—'}  ·  Sunset: {d.sunset || '—'}</Text>}
          </View>
          <View style={{ flex: 2, padding: '2pt 4pt' }}>
            {d.generalNote && <Text style={S.bold}>{d.generalNote}</Text>}
          </View>
        </TRow>

        {/* Scene table */}
        <SceneTable event={event} allScenes={allScenes || []} />

        {/* Cast table */}
        <CastTable castRows={d.castRows} shootCall={d.shootCall || event?.startTime} />

        {/* Extras + Special Instructions */}
        <ExtrasAndInstructions extras={d.extras} specialInstructions={d.specialInstructions} />

        {/* Advance schedule */}
        <AdvanceSchedule advanceSceneIds={d.advanceSceneIds} allScenes={allScenes || []} />

        {/* Footer */}
        <View style={{ position: 'absolute', bottom: '10mm', left: '10mm', right: '10mm' }}>
          <View style={[S.row, { borderTop: '0.5pt solid #000', paddingTop: '2pt' }]}>
            <Text style={{ flex: 1 }}>1st AD: {firstAD?.name || '—'}</Text>
            <Text style={{ flex: 1, textAlign: 'center' }}>Producer: {producer?.name || '—'}</Text>
            <Text style={{ flex: 1, textAlign: 'right' }}>{orgName || ''}</Text>
          </View>
        </View>
      </Page>

      {/* ── PAGE 2 ── */}
      <Page size="A4" style={S.page}>

        {/* Header */}
        <TRow style={{ marginBottom: '4pt', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 9 }}>Day {d.dayNumber ?? 1} of {d.totalDays ?? '?'}</Text>
          </View>
          <View style={{ flex: 2, alignItems: 'center' }}>
            <Text style={S.p2Title}>{projectTitle || 'PRODUCTION TITLE'}</Text>
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={{ fontSize: 9 }}>{fmtDate(event?.date)}</Text>
          </View>
        </TRow>
        <TRow style={{ marginBottom: '6pt' }}>
          <Text style={{ flex: 1 }}>Travel from unit base to set: {d.travelMins ?? 0} min</Text>
          <Text style={[S.bold, { fontSize: 10 }]}>Crew Call  {crewCallDisplay}</Text>
        </TRow>

        {/* 2-column dept grid */}
        <TRow style={{ alignItems: 'flex-start' }}>
          <View style={{ flex: 1, marginRight: '4pt' }}>
            {[
              ['Direction', ['director', '1st ad', '2nd ad', '2nd 2nd ad']],
              ['Production', ['producer', 'asst. producer', 'line producer', 'production manager', 'production coordinator']],
              ['Script', ['script supervisor']],
              ['Camera', ['director of photography', 'dp', '1st ac', '2nd ac', 'camera operator', 'dit', 'bts', 'making-of', 'dailies']],
              ['Grip / Electric', ['gaffer', 'spark', 'grip', 'best boy']],
            ].map(([title, roles]) => {
              const members = crew.filter(m => roles.some(r => m.role?.toLowerCase().includes(r)))
              const deptKey = title.toLowerCase().replace(/\s/g, '_')
              return (
                <DeptCallBlock
                  key={title}
                  title={title}
                  members={members}
                  defaultCall={d.crewCall || event?.startTime || '10:00'}
                  override={overrides[deptKey]}
                />
              )
            })}
          </View>
          <View style={{ flex: 1 }}>
            {[
              ['Art Department', ['production designer', 'art director', 'art assistant', 'set designer', 'props master', 'props assistant', 'set dresser']],
              ['Special Effects', ['stunt coordinator', 'fight coordinator', 'sfx coordinator', 'sfx', 'stunt']],
              ['Make-up', ['make-up', 'makeup', 'hair']],
              ['Costume', ['costume designer', 'costume assistant', 'wardrobe']],
              ['Locations & Transpo', ['location manager', 'location', 'transport', 'driver', 'security']],
            ].map(([title, roles]) => {
              const members = crew.filter(m => roles.some(r => m.role?.toLowerCase().includes(r)))
              const deptKey = title.toLowerCase().replace(/[\s&\/]+/g, '_')
              return (
                <DeptCallBlock
                  key={title}
                  title={title}
                  members={members}
                  defaultCall={d.crewCall || event?.startTime || '10:00'}
                  override={overrides[deptKey]}
                />
              )
            })}
          </View>
        </TRow>

        {/* Map space */}
        <View style={{ border: '0.5pt solid #000', height: '50pt', marginTop: '4pt', marginBottom: '4pt', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[{ color: '#aaa' }, S.caps]}>Space for a map to location</Text>
        </View>

        {/* Emergency */}
        <TRow style={{ marginBottom: '4pt' }}>
          {[['Emergency', d.emergencyPhone], ['Police', d.policePhone], ['Fire', d.firePhone]].map(([lbl, val]) => (
            <View key={lbl} style={{ flex: 1, border: '0.5pt solid #000', padding: '2pt 4pt', marginRight: lbl !== 'Fire' ? '2pt' : 0 }}>
              <Text style={[S.bold, S.caps, { fontSize: 6 }]}>{lbl}</Text>
              <Text style={{ fontSize: 9 }}>{val || '[---]'}</Text>
            </View>
          ))}
        </TRow>

        {/* Radio + Reminders */}
        <TRow style={{ marginBottom: '4pt' }}>
          <View style={{ flex: 1, border: '0.5pt solid #000', padding: '3pt', marginRight: '2pt' }}>
            <Text style={[S.bold, S.caps, { fontSize: 6, marginBottom: '2pt' }]}>Radio Channels</Text>
            <Text style={{ fontSize: 6.5, lineHeight: 1.5 }}>{d.radioChannels || '—'}</Text>
          </View>
          <View style={{ flex: 2, border: '0.5pt solid #000', padding: '3pt' }}>
            <Text style={[S.bold, S.caps, { fontSize: 6, marginBottom: '2pt' }]}>Reminders</Text>
            <Text style={{ fontSize: 6.5, lineHeight: 1.5 }}>{d.reminders || '—'}</Text>
          </View>
        </TRow>

        {/* Quote + Hospital */}
        <TRow>
          <View style={{ flex: 2, padding: '3pt' }}>
            {d.quote && <Text style={[S.italic, { fontSize: 8 }]}>"{d.quote}"</Text>}
          </View>
          <View style={{ flex: 1, padding: '3pt', borderLeft: '0.5pt solid #000' }}>
            <Text style={[S.bold, S.caps, { fontSize: 6 }]}>Nearest Hospital</Text>
            <Text style={{ fontSize: 6.5 }}>{d.hospitalAddress || '—'}</Text>
          </View>
        </TRow>

      </Page>
    </Document>
  )
}
