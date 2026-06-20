import nodemailer from 'nodemailer'

export const emailConfigured = () => !!process.env.SMTP_HOST

function createTransport() {
  if (!process.env.SMTP_HOST) return null
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    secure: parseInt(process.env.SMTP_PORT ?? '587') === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  })
}

export async function sendOnboardingEmail({ to, name, projectTitle, role, link }) {
  const transport = createTransport()
  if (!transport) return false

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'noreply@osfpm.local'

  await transport.sendMail({
    from,
    to,
    subject: `Complete your onboarding for ${projectTitle}`,
    text: [
      `Hi ${name},`,
      '',
      `You've been added to "${projectTitle}" as ${role}.`,
      '',
      `Please complete your onboarding by visiting:`,
      link,
      '',
      `This link is personal to you — do not share it. It expires in 7 days.`,
      '',
      `— OSFPM`,
    ].join('\n'),
    html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:40px 20px;background:#0d0d0d;font-family:system-ui,-apple-system,sans-serif">
  <div style="max-width:520px;margin:0 auto">
    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:40px">
      <p style="margin:0 0 28px;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#666">OSFPM</p>
      <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#fff">Welcome to ${projectTitle}</h1>
      <p style="margin:0 0 24px;font-size:14px;color:#888">
        You've been added as <strong style="color:#e0e0e0">${role}</strong>.
      </p>
      <p style="margin:0 0 28px;font-size:14px;line-height:1.7;color:#bbb">
        Please take a few minutes to fill out your onboarding form. This helps the production team with scheduling, safety, and catering.
      </p>
      <a href="${link}"
         style="display:inline-block;padding:13px 26px;background:#c9a84c;color:#000;font-size:14px;font-weight:700;text-decoration:none;border-radius:6px">
        Complete onboarding →
      </a>
      <p style="margin:28px 0 0;font-size:12px;color:#444;line-height:1.6">
        This link is personal to you — please don't share it. It expires in 7 days.<br>
        If the button doesn't work, copy this address into your browser:<br>
        <span style="color:#666">${link}</span>
      </p>
    </div>
  </div>
</body>
</html>`,
  })

  return true
}
