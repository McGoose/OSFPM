# Crew & Cast

**Status:** Live  
**Route:** `/projects/:id/crew`  
**Scope:** Project-level

The Crew & Cast tool manages everyone involved in a production — both cast (actors) and crew (production staff). It handles contact information, welfare needs, account creation, and onboarding.

---

## Layout

A two-panel view:

- **Left panel** — searchable, filterable member list. Tabs separate Cast and Crew. Members can be sorted by drag.
- **Right panel** — detail form for the selected member, or an add form when creating a new member.

---

## Member types

| Type | Extra fields |
|---|---|
| Crew | Department, job title |
| Cast | Character name, agent details |

---

## Member fields

### Basic info
- Full name
- Email address
- Phone number
- Pronouns
- Role (job title for crew, role name for cast)
- Character name (cast only)
- Department (crew only)
- Status: `pending` / `confirmed` / `wrapped`
- Start date / End date
- Notes

### Personal & welfare
- Dietary needs — allergies, preferences, religious requirements
- Medical needs & allergies — EpiPen, inhalers, conditions crew leads should know about
- Accessibility needs — wheelchair access, BSL, hearing loop, etc.

### Emergency contact
- Name, phone, relationship

### Agent / representative (cast only)
- Name, email, phone

---

## Onboarding system

Members fill out their own sensitive details (dietary, medical, accessibility, emergency contact) through a personal onboarding link rather than the admin entering it on their behalf.

### Admin flow
1. Add a member with at minimum their name and email.
2. Click **Send onboarding link** in the member's detail panel.
3. The server generates a unique 64-character token, stores it with a 7-day expiry, and sends the member an email with their personal link.
4. If SMTP is not configured, the link is shown in the UI with a copy button for manual sharing.

### Member flow
The member visits `/onboard/:token` — no login required. They see a form with:
- Contact details (pre-filled with what the admin entered)
- Dietary & medical section
- Accessibility section
- Emergency contact
- Agent / representative (cast only)
- Password section (to create their OSFPM account)

On first submission the member **chooses their own password** and an OSFPM account is created automatically using their email address. They can then log in to OSFPM with regular credentials.

### Subsequent links
If a member needs to update their details or reset their password, the admin clicks **Resend link**. A new token is generated and the member can update anything — including setting a new password — by returning to the link.

Admins cannot set or see member passwords at any point.

---

## OSFPM accounts

When a member completes their onboarding form and sets a password, an account is created with the `crew` role. This gives them access to OSFPM to view project information relevant to their role.

The Crew & Cast detail panel shows whether a member has an active account (◉ Account active) or not (link still pending or not yet sent).

---

## Deleting members

Only admins can delete a crew or cast member. Deletion is permanent and removes all associated data.
