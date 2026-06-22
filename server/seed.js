// Run with: node seed.js
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { eq } from 'drizzle-orm'
import path from 'path'
import { fileURLToPath } from 'url'
import * as schema from './src/db/schema.js'
import {
  users, projects, departments, crewMembers,
  scenes, breakdownElements, events, eventScenes
} from './src/db/schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const client = createClient({ url: `file:${path.join(__dirname, '../data/osfpm.db')}` })
const db = drizzle(client, { schema })

// ── Find the admin user ────────────────────────────────────────────────────────
// Find any admin user (the logged-in test user)
let [adminUser] = await db.select().from(users).where(eq(users.email, '00515990@metfilmstudents.ac.uk'))
if (!adminUser) {
  // Fall back to first admin in DB
  const allAdmins = await db.select().from(users).where(eq(users.role, 'admin'))
  adminUser = allAdmins[0]
}
if (!adminUser) { console.error('No admin user found — run the app and complete /setup first.'); process.exit(1) }
console.log(`Seeding as user: ${adminUser.name} (${adminUser.email})`)

const now = new Date()

// ── Project ───────────────────────────────────────────────────────────────────
await client.execute(`DELETE FROM projects WHERE title = 'The Last Withdrawal'`)

const [proj] = await db.insert(projects).values({
  title: 'The Last Withdrawal',
  genre: 'Comedy / Heist',
  format: 'Feature Film',
  status: 'pre_production',
  description: 'Six bingo-hall regulars, all well past retirement age, decide the only logical response to the cost-of-living crisis is to rob the bank that repossessed their community centre. What could possibly go wrong? Everything. Everything could go wrong.',
  createdBy: adminUser.id,
  createdAt: now,
}).returning()
const projectId = proj.id
console.log(`Created project: ${proj.title} (id ${projectId})`)

// ── Departments ───────────────────────────────────────────────────────────────
const DEPTS = [
  { name: 'Direction',          icon: '🎬', sortOrder: 0 },
  { name: 'Production',         icon: '📋', sortOrder: 1 },
  { name: 'Camera',             icon: '📷', sortOrder: 2 },
  { name: 'Grip & Electric',    icon: '💡', sortOrder: 3 },
  { name: 'Art Department',     icon: '🎨', sortOrder: 4 },
  { name: 'Costume & Make-up',  icon: '👗', sortOrder: 5 },
  { name: 'Sound',              icon: '🎙️', sortOrder: 6 },
  { name: 'Locations',          icon: '📍', sortOrder: 7 },
  { name: 'Post Production',    icon: '🖥️', sortOrder: 8 },
]
const deptRows = await db.insert(departments).values(
  DEPTS.map(d => ({ ...d, projectId }))
).returning()
const deptMap = Object.fromEntries(deptRows.map(d => [d.name, d.id]))
console.log(`Created ${deptRows.length} departments`)

// ── Crew — one per role ───────────────────────────────────────────────────────
// The user is the Producer
const CREW = [
  // Direction
  { role: 'Director',           name: 'Rodrigo Fuentes-Vega',    deptName: 'Direction'        },
  { role: '1st Assistant Director', name: 'Priya Chakraborty',   deptName: 'Direction'        },
  { role: '2nd Assistant Director', name: 'Ollie Birch',         deptName: 'Direction'        },
  // Production — user is Producer
  { role: 'Producer',           name: adminUser.name,            email: adminUser.email, deptName: 'Production', userId: adminUser.id },
  { role: 'Line Producer',      name: 'Sandra Kettlewell',       deptName: 'Production'       },
  { role: 'Production Coordinator', name: 'Tomás Álvarez',       deptName: 'Production'       },
  { role: 'Production Runner',  name: 'Amelia Fitch',            deptName: 'Production'       },
  // Camera
  { role: 'Director of Photography', name: 'Nakamura Hiroshi',   deptName: 'Camera'           },
  { role: '1st AC',             name: 'Zoe Pennington',          deptName: 'Camera'           },
  { role: '2nd AC / DIT',       name: 'Marcus Webb',             deptName: 'Camera'           },
  { role: 'BTS / Making Of',    name: 'Cleo Okafor',             deptName: 'Camera'           },
  // Grip & Electric
  { role: 'Gaffer',             name: 'Declan Murtagh',          deptName: 'Grip & Electric'  },
  { role: 'Best Boy Electric',  name: 'Yuki Tanaka',             deptName: 'Grip & Electric'  },
  { role: 'Key Grip',           name: 'Viktor Sorokin',          deptName: 'Grip & Electric'  },
  // Art
  { role: 'Production Designer', name: 'Imogen Harcastle',       deptName: 'Art Department'   },
  { role: 'Art Director',       name: 'Femi Adeyemi',            deptName: 'Art Department'   },
  { role: 'Props Master',       name: 'Dot Ramsbottom',          deptName: 'Art Department'   },
  { role: 'Set Dresser',        name: 'Luca Barone',             deptName: 'Art Department'   },
  // Costume & MU
  { role: 'Costume Designer',   name: 'Harriet Bloom',           deptName: 'Costume & Make-up'},
  { role: 'Hair & Make-up Artist', name: 'Destiny Nwosu',        deptName: 'Costume & Make-up'},
  // Sound
  { role: 'Sound Mixer',        name: 'Alistair Drummond',       deptName: 'Sound'            },
  { role: 'Boom Operator',      name: 'Ingrid Svensson',         deptName: 'Sound'            },
  // Locations
  { role: 'Location Manager',   name: 'Patrick Foley',           deptName: 'Locations'        },
  { role: 'Unit Manager',       name: 'Chinyere Obiora',         deptName: 'Locations'        },
  { role: 'Transport Captain',  name: 'Ray Stubbs',              deptName: 'Locations'        },
  // Post
  { role: 'Editor',             name: 'Simone Lefèvre',          deptName: 'Post Production'  },
  { role: 'Stunt Coordinator',  name: 'Dave "The Knee" Tulloch', deptName: 'Direction'        },
  { role: 'Script Supervisor',  name: 'Niamh Callahan',          deptName: 'Direction'        },
]

const crewInserted = await db.insert(crewMembers).values(
  CREW.map((c, i) => ({
    projectId,
    type: 'crew',
    name: c.name,
    email: c.email || '',
    role: c.role,
    departmentId: deptMap[c.deptName] ?? null,
    userId: c.userId ?? null,
    status: 'confirmed',
    sortOrder: i,
    createdAt: now,
  }))
).returning()
console.log(`Created ${crewInserted.length} crew members (you are the Producer)`)

// ── Cast ──────────────────────────────────────────────────────────────────────
const CAST = [
  { name: 'Margaret Thornbury',  role: 'Lead',         characterName: 'DORIS',       notes: 'Ringleader. Former MI5 librarian. Never admits it.'         },
  { name: 'Brian Chucksworth',   role: 'Lead',         characterName: 'GERALD',      notes: 'Demolitions "expert". Learned from YouTube.'               },
  { name: 'Patricia Bottomley',  role: 'Lead',         characterName: 'ETHEL',       notes: 'Getaway driver. Has not driven since 1987.'                 },
  { name: 'Derek Pemberton',     role: 'Lead',         characterName: 'NORMAN',      notes: 'Tech guy. Owns one (1) smartphone. It is a Nokia.'         },
  { name: 'Sylvia Crumpet',      role: 'Lead',         characterName: 'BARBARA',     notes: 'Distraction specialist. Wears increasingly unhinged hats.' },
  { name: 'Geoffrey Whimple',    role: 'Supporting',   characterName: 'ARNOLD',      notes: 'Lookout. Profoundly hard of hearing. Owns a dog.'           },
  { name: 'Constance Brisket',   role: 'Supporting',   characterName: 'DCI BARNACLE',notes: 'The detective on the case. Suspiciously useless.'           },
  { name: 'Archibald Noonan',    role: 'Supporting',   characterName: 'BANK MANAGER',notes: 'Sweats constantly. Even in winter.'                         },
  { name: 'Kylie Chen',          role: 'Day Player',   characterName: 'YOUNG TELLER',notes: 'Entirely unfazed by the whole situation.'                  },
  { name: 'Winston Ogilvie',     role: 'Day Player',   characterName: 'SECURITY GUARD', notes: 'Six foot four. Terrified of pensioners.'               },
]

const castInserted = await db.insert(crewMembers).values(
  CAST.map((c, i) => ({
    projectId,
    type: 'cast',
    name: c.name,
    email: '',
    role: c.role,
    characterName: c.characterName,
    notes: c.notes,
    status: 'confirmed',
    sortOrder: i,
    createdAt: now,
  }))
).returning()
console.log(`Created ${castInserted.length} cast members`)

// ── 20 Scenes ─────────────────────────────────────────────────────────────────
const SCENES = [
  {
    n: '1', intExt: 'INT', location: 'BINGO HALL', tod: 'DAY', pages: 3,
    desc: 'DORIS surveys her crew across folding tables. None of them look like criminals. Perfect.',
    content: `Rows of folding tables dressed with bingo cards and daubers. An urn of tea gurgles in the corner. The hall is faded but well-loved.

DORIS (72, steel-grey bob, reading glasses like armour) surveys the room. Opposite her: GERALD (74), ETHEL (71), NORMAN (76), BARBARA (73, today's hat: a fascinator shaped like a macaw) and ARNOLD (75, hearing aids switched off, a basset hound asleep at his feet).

DORIS
Right. Four weeks before the council bulldozes this building. One chance to save it.

She produces a photograph of FIRST NATIONAL BANK and sets it on the table between the bingo cards.

BARBARA
(tapping a dauber against her macaw)
Is it a raffle?

GERALD
It is not a raffle.

BARBARA
Jumble sale?

DORIS
Bank robbery.

Silence. ETHEL pours tea. NORMAN squints through one-armed reading glasses.

ARNOLD
(missed all of it)
Yes, lovely, I'll have a biscuit.

ETHEL
Which bank?

DORIS
The one that took our community centre.

NORMAN
I've got forty-three quid in there. And some conkers from 2007.

DORIS
That is precisely why they owe us.

GERALD leans forward. For the first time in years, he looks interested.

GERALD
I've been waiting for something like this.

ETHEL
You've been waiting to rob a bank?

GERALD
I've been waiting to be useful again.

A beat. Even BARBARA stops tapping her dauber.

DORIS
(quiet, certain)
We all have.`,
  },
  {
    n: '2', intExt: 'INT', location: 'DORIS\'S KITCHEN', tod: 'NIGHT', pages: 2,
    desc: 'Over a pot of tea and a suspicious number of biscuits, the plan is hatched on a paper napkin.',
    content: `A small, warm kitchen. A teapot on a crocheted mat. DORIS, GERALD, ETHEL, NORMAN, and BARBARA crowd around the table.

A paper napkin is spread between them. On it: a rough sketch of a bank floor plan.

DORIS
Entry through the front. BARBARA creates the distraction. GERALD handles the — technical side. ETHEL waits outside with the car.

ETHEL
Can I park on double yellows?

NORMAN
We're committing armed robbery, Ethel. I think parking fines are the least of it.

ETHEL
I just don't want a ticket.

BARBARA studies the paper napkin, leaving a ring from her mug.

BARBARA
What do I wear?

DORIS
Something memorable.

BARBARA
(already delighted)
Oh, I've got just the thing.

GERALD reaches across and draws a large X on the napkin.

GERALD
The vault. My department.

NORMAN
You can't just draw an X and call it your department.

GERALD
I just did.

DORIS folds the paper napkin carefully and pockets it. The biscuits are almost gone.

DORIS
We tell no one. We practise. And nobody — nobody — panics.

Everyone nods. BARBARA is already mentally planning her hat.`,
  },
  {
    n: '3', intExt: 'EXT', location: 'FIRST NATIONAL BANK', tod: 'DAY', pages: 1.5,
    desc: 'The crew drive past the bank. Very slowly. Several times. People start staring.',
    content: `The high street. FIRST NATIONAL BANK gleams between a charity shop and a bakery.

The 1992 beige Ford Fiesta crawls past at approximately four miles per hour. DORIS in the passenger seat, GERALD craning from the back.

DORIS
Once more. Slowly.

ETHEL
We've been past seven times, Doris. That man outside the bakery has started waving.

The Fiesta completes another glacial circuit. DORIS writes notes on the back of a pension statement.

GERALD
Two cameras. One above the door, one at the counter.

NORMAN
(on his Nokia)
How do I take a photo on this thing?

ETHEL
You press the button on the side.

NORMAN
Which side?

The Fiesta drifts gently into the bus lane. A BUS DRIVER honks. Nobody reacts.

DORIS
The loading bay round the back. That's our exit.

GERALD
Our exit is the front door. More direct.

DORIS
We are not walking out the front door carrying bags of money, Gerald.

GERALD
Why not?

DORIS stares at him.

GERALD (CONT'D)
Fair enough.`,
  },
  {
    n: '4', intExt: 'INT', location: 'SHOPPING MALL', tod: 'DAY', pages: 2,
    desc: 'Disguise shopping goes poorly. BARBARA insists on a feathered hat. Nobody stops her.',
    content: `A busy shopping mall. DORIS and BARBARA move through the crowds. DORIS holds a list.

DORIS
We need something that says "ordinary member of the public." Nothing memorable.

BARBARA stops at a shop window displaying an enormous feathered hat. Peacock blue. Three feet wide.

BARBARA
That one.

DORIS
That is the opposite of what I said.

BARBARA
It's a distraction.

DORIS
It's a landmark. They'll be able to see you from the ring road.

BARBARA
(already going inside)
Exactly.

Inside the shop. BARBARA tries on the feathered hat. It is enormous. The SHOP ASSISTANT takes a small step back.

SHOP ASSISTANT
It's... very striking.

BARBARA
Thank you.

SHOP ASSISTANT
I wasn't sure that was a compliment.

BARBARA
I know.

DORIS watches from the doorway, arms crossed.

DORIS
(to herself)
This is going to work. This is absolutely going to work.

She does not look convinced. She goes in and buys it anyway.`,
  },
  {
    n: '5', intExt: 'INT', location: 'GERALD\'S GARAGE', tod: 'NIGHT', pages: 2,
    desc: 'GERALD presents his "gadgets": a leaf blower modified into something unidentifiable and deeply concerning.',
    content: `A garage crammed with tools, half-finished projects, and decades of optimism. A tool bench runs along one wall. Safety goggles hang on a hook, unused.

GERALD stands proudly before a sheet-covered object. DORIS and ETHEL watch from the doorway.

GERALD
Ladies. I give you — Project Thunderclap.

He whips off the sheet. Reveals: a leaf blower. Modified. Heavily. With what appears to be a vacuum cleaner attachment, a car battery, and several components that have no obvious origin.

ETHEL
What is it?

GERALD
A distraction device. Electronic.

DORIS
It looks like a leaf blower.

GERALD
It was a leaf blower.

DORIS
What does it do now?

GERALD
(pause)
I'm still working that out. But it makes an excellent noise.

He switches it on. A sound like a very confused hoover fills the garage.

ETHEL
Gerald, you've had four weeks.

GERALD
I've been thorough.

DORIS picks up the safety goggles from the hook and hands them to GERALD.

DORIS
Put these on. And turn it off.

GERALD
I can't turn it off. That bit isn't working yet.

They both look at the modified leaf blower. It continues to make its noise.

GERALD (CONT'D)
I'll sort it by Tuesday.`,
  },
  {
    n: '6', intExt: 'EXT', location: 'MUNICIPAL PARK', tod: 'DAY', pages: 1.5,
    desc: 'Practice run. ETHEL drives the getaway vehicle — a 1992 beige Ford Fiesta — around the boating lake.',
    content: `The municipal park. Ducks on a boating lake. Dog walkers. A man with a metal detector.

The 1992 beige Ford Fiesta idles at the park entrance. DORIS stands with a stopwatch. ARNOLD sits on a bench with his basset hound.

DORIS
One circuit of the lake. Full speed. Go.

ETHEL
(from the car)
Define full speed.

DORIS
As fast as you can safely go.

ETHEL
That's what I'm asking.

A beat.

DORIS
Just go.

The Fiesta pulls away. Sedately. It reaches approximately 19 miles per hour before reaching the first corner, where ETHEL slows to indicate.

ARNOLD
(to his dog)
She's very good, isn't she, Bruce.

DORIS checks the stopwatch. Then checks it again. She shows it to no one.

The Fiesta completes the circuit in four minutes and twelve seconds. It parks neatly.

ETHEL
(emerging)
How was that?

DORIS
You indicated at every junction.

ETHEL
Force of habit. Forty years.

DORIS
We're robbing a bank, Ethel. We don't indicate.

ETHEL
I'll try.`,
  },
  {
    n: '7', intExt: 'INT', location: 'FIRST NATIONAL BANK', tod: 'DAY', pages: 2,
    desc: 'Reconnaissance disguised as ordinary banking. NORMAN tries to withdraw 10p. The teller weeps.',
    content: `The bank interior. Marble floors. A long queue. Everything designed to make you feel small.

NORMAN shuffles to the counter. He takes out his Nokia and squints at a number written on his hand.

YOUNG TELLER
(professional smile)
How can I help?

NORMAN
I'd like to make a withdrawal.

YOUNG TELLER
Of course. How much?

NORMAN
Ten pence.

A beat.

YOUNG TELLER
...Ten pence.

NORMAN
I want to check everything's working. Financially.

YOUNG TELLER
Your account is fine, Mr —

NORMAN
It's fine?

YOUNG TELLER
It's fine.

NORMAN looks around the bank. Counts the cameras. Notes the position of the SECURITY GUARD. Looks at the vault door.

YOUNG TELLER (CONT'D)
Did you want the ten pence?

NORMAN
No, I was just curious.

The YOUNG TELLER stares at him. NORMAN nods politely and shuffles away.

The BANK MANAGER watches from his office window, sweating slightly. He watches NORMAN leave. He continues watching the door for some time after.`,
  },
  {
    n: '8', intExt: 'INT', location: 'BINGO HALL', tod: 'NIGHT', pages: 2,
    desc: 'Final briefing. ARNOLD mishears every single instruction. Nobody corrects him.',
    content: `Night. The bingo hall cleared of visitors. DORIS addresses the group around a table. Bingo cards have been repurposed as note cards. Daubers stand in a cup.

DORIS
Tomorrow. Zero eight hundred hours. We go in sequence. BARBARA enters first —

ARNOLD
(cheerfully)
Bernard? Bernard's not coming, is he?

DORIS
Barbara.

ARNOLD
I didn't know Barbara was coming.

BARBARA
I'm right here, Arnold.

ARNOLD
Hello, Barbara.

DORIS
(pressing on)
GERALD, your device goes in the loading bay —

ARNOLD
Loading day? Is it a delivery?

GERALD
(to ARNOLD, gently)
Shut up, Arnold.

ARNOLD nods warmly. He has no idea what was said.

ARNOLD's basset hound, BRUCE, is asleep under the table, dreaming.

DORIS
Any questions?

ETHEL
Can I bring a flask?

DORIS
No.

ETHEL
Thermos? Small one?

DORIS
No.

ETHEL
I'll get thirsty.

DORIS
Ethel.

ETHEL
Fine.

ARNOLD
(completely unrelated)
I had a lovely sandwich today. Egg and cress.

Everyone stares at him.

ARNOLD (CONT'D)
Very fresh.`,
  },
  {
    n: '9', intExt: 'INT', location: 'BEDROOM - DORIS\'S HOUSE', tod: 'NIGHT', pages: 1.5,
    desc: 'DORIS stares at the ceiling. A beat. She smiles.',
    content: `Small, tidy bedroom. A single bed. A framed photograph on the nightstand — DORIS younger, in front of a building we can't quite make out.

DORIS lies on top of the covers, fully dressed except for her shoes. Eyes open. She stares at the ceiling.

A long silence.

She goes over it in her head. Entry. BARBARA. GERALD. ETHEL outside. NORMAN on comms. ARNOLD as lookout.

ARNOLD as lookout.

She closes her eyes briefly.

Then opens them. And smiles. Not the smile of someone confident everything will go right. The smile of someone who has made her peace with the fact that it probably won't.

She reaches over and turns off the light.

DORIS
(to no one, quietly)
Right then.`,
  },
  {
    n: '10', intExt: 'EXT', location: 'RESIDENTIAL STREET', tod: 'DAY', pages: 1,
    desc: 'The crew assemble in front of ETHEL\'s Fiesta. Nobody fits.',
    content: `Morning. A quiet residential street. The 1992 beige Ford Fiesta parked at the kerb.

DORIS arrives first. Studies the car. Studies the group as they arrive one by one: GERALD with a rucksack, BARBARA with an enormous hatbox, NORMAN with his Nokia pressed to one ear, ARNOLD with BRUCE on a lead.

DORIS
Arnold. You cannot bring the dog.

ARNOLD
He'll be fine in the car.

DORIS
He cannot come to the bank.

ARNOLD
He'll wait outside.

DORIS
Arnold —

ARNOLD
He hates being left alone, Doris. He howls.

Beat.

DORIS
Fine. He stays in the car with Ethel.

ETHEL
(appearing from behind the Fiesta)
Absolutely not. He drools on the seat.

BRUCE looks up at everyone with enormous, sorrowful eyes.

GERALD
He can sit on my lap.

Everyone looks at GERALD.

GERALD (CONT'D)
What? I like dogs.

They all attempt to get into the Fiesta. It takes some time.`,
  },
  {
    n: '11', intExt: 'INT', location: 'FIRST NATIONAL BANK', tod: 'DAY', pages: 4,
    desc: 'THE HEIST BEGINS. BARBARA\'s hat causes immediate panic. This is not unintentional.',
    content: `The bank. Busy morning. A queue of ordinary customers.

The doors open. BARBARA enters. The feathered hat is even larger than it appeared in the shop. Peacock blue. It is, objectively, an event.

A CUSTOMER drops their phone. The YOUNG TELLER's professional smile wavers. The BANK MANAGER, visible in his glass office, begins to sweat.

BARBARA
(loudly, to no one in particular)
Lovely building. Very institutional.

She takes up a position by the leaflet stand, blocking the camera.

DORIS enters behind her, calm, carrying a large handbag. She clocks the positions of the SECURITY GUARD (six foot four, already eyeing BARBARA), the BANK MANAGER, the vault door.

Behind DORIS: GERALD, NORMAN, and ARNOLD (who holds BRUCE on a lead).

DORIS
(quiet, to GERALD)
Why is the dog inside?

GERALD
(quiet, to DORIS)
He wouldn't stay in the car.

ARNOLD
(louder than necessary)
He loves banks. Very calm atmosphere.

The SECURITY GUARD takes a step toward ARNOLD. Sees BRUCE. Stops. The SECURITY GUARD appears to be frightened of BRUCE.

BRUCE sits down and yawns.

DORIS
(to NORMAN)
Comms.

NORMAN dials something on his Nokia. Something that is probably not what he intends to dial, but he looks focused.

DORIS produces four duffel bags from her handbag. There is no logical reason they all fit. She hands them out.

BANK MANAGER
(emerging, perspiring)
Can I help — is that a dog?

BARBARA sweeps her feathered hat and knocks three leaflet displays to the floor.

BARBARA
Sorry! Caught a bit of a draught.

The BANK MANAGER stares at the leaflets. Then at BARBARA's feathered hat. Then at BRUCE. He is having the worst Tuesday of his professional life.

DORIS
(perfectly pleasantly)
We'd like to make a withdrawal, please.

She produces a note. Handwritten on a paper napkin. The BANK MANAGER reads it. Reads it again. His forehead glistens.

BANK MANAGER
(very quietly)
Is this a robbery?

DORIS
We prefer "community reallocation."

The SECURITY GUARD takes one look at GERALD, DORIS, BARBARA's feathered hat, ARNOLD, BRUCE, and NORMAN's Nokia — and sits down in a nearby chair.

SECURITY GUARD
(barely audible)
I can't. I just can't today.`,
  },
  {
    n: '12', intExt: 'INT', location: 'BANK VAULT', tod: 'DAY', pages: 3,
    desc: 'GERALD cracks the vault. It was already open. He claims credit anyway.',
    content: `A corridor behind the main banking floor. The vault door is large, imposing, and — as GERALD discovers — slightly ajar.

GERALD
(hand on the vault door)
Stand back. This could take a while.

He produces a stethoscope from his rucksack.

DORIS
Gerald. It's already open.

GERALD
(pause)
I know.

DORIS
It was open when we got here.

GERALD
I'm aware.

DORIS
You haven't done anything.

GERALD
I applied pressure. Psychological.

DORIS pushes the vault door. It swings open easily.

The vault. Rows of stacked cash trays on metal shelves. Safety deposit boxes along the walls. A faint hum of air conditioning.

DORIS
Right. Quickly.

GERALD
(looking around with satisfaction)
You know, I've always wanted to do this.

DORIS
Gerald.

GERALD
Forty years as an engineer and this is the most satisfying thing I've—

DORIS
Gerald.

They begin filling duffel bags. DORIS is methodical. GERALD picks up a cash tray and examines it with professional interest.

GERALD
Interesting system. Very 2003.

DORIS
How long were you planning to do engineering for?

GERALD
(filling the bag)
Oh, I'm not an engineer. I just liked the sound of it.

A beat. DORIS stops. Looks at him.

DORIS
You've spent forty years telling people you're an engineer.

GERALD
It's a good word. Authoritative.

DORIS resumes filling the bag. There is nothing to be said.

GERALD (CONT'D)
I did do a night class. In 1981. Woodwork, mostly.

DORIS
Come on.`,
  },
  {
    n: '13', intExt: 'INT', location: 'FIRST NATIONAL BANK', tod: 'DAY', pages: 2,
    desc: 'SECURITY GUARD gives chase. He is six foot four and extremely slow. The gang are slower. It is tense.',
    content: `The banking floor. The SECURITY GUARD has recovered. He is six foot four, built like a wardrobe, and now moving — slowly but with commitment — toward GERALD and ETHEL.

SECURITY GUARD
(with great effort)
Stop. Right there.

GERALD does not stop. He does, however, trip over ARNOLD's walking frame, which has been left unattended near the counter.

This is, technically, a stunt.

GERALD
(on the floor)
I'm fine!

ETHEL tries to help GERALD up. BARBARA arrives to help ETHEL. ARNOLD arrives to help and accidentally blocks the SECURITY GUARD's path entirely.

The SECURITY GUARD stops. Looks at ARNOLD.

ARNOLD
(cheerfully)
Lovely day, isn't it?

The SECURITY GUARD, six foot four, terrified of pensioners, looks at the ceiling.

DORIS, bags collected, appears at ETHEL's side.

DORIS
(to the group, very calm)
We're leaving now.

BARBARA sweeps her feathered hat and catches the SECURITY GUARD in the chin.

BARBARA
So sorry! Such an awkward hat!

GERALD gets upright. They move, collectively, toward the exit. It is not fast. The SECURITY GUARD watches them go.

BANK MANAGER
(appearing from his office)
Aren't you going to chase them?

SECURITY GUARD
(watching the group shuffle toward the door)
They'll be here until Thursday at this rate. I'll catch them at the door.

He does not catch them at the door.`,
  },
  {
    n: '14', intExt: 'EXT', location: 'FIRST NATIONAL BANK', tod: 'DAY', pages: 2,
    desc: 'The getaway. ETHEL cannot find reverse. DORIS navigates from a 2009 A-to-Z.',
    content: `The bank entrance. DORIS leads the group out, bags in hand. The 1992 beige Ford Fiesta idles at the kerb.

Except it doesn't. It is parked the wrong way.

DORIS
Ethel. Wrong direction.

ETHEL
(from the driver's window)
I know. I can't find reverse.

DORIS
You've had this car for thirty years.

ETHEL
I've never needed reverse before.

GERALD
It's the R. On the gearstick.

ETHEL
I know which letter it is, Gerald.

DORIS opens the passenger door and drops in. She produces a 2009 A-to-Z from her handbag. Begins studying it.

GERALD, BARBARA, ARNOLD, BRUCE and their duffel bags pile into the back. The Fiesta groans.

DORIS
Left out of here, right at the lights, then—

ETHEL
I know the way.

DORIS
The 2009 A-to-Z says—

ETHEL
I grew up here, Doris. I know the way.

The Fiesta finds reverse with a crunch. Rolls back six inches. ETHEL puts it in first. They pull away. Slowly. Correctly.

DORIS checks the A-to-Z.

DORIS
You've missed the turning.

ETHEL
I have not.

DORIS
You have. We should have gone left.

ETHEL
We're going right.

DORIS
Page forty-seven clearly shows—

They drive away. Into the traffic. And away.`,
  },
  {
    n: '15', intExt: 'INT', location: 'FORD FIESTA - MOVING', tod: 'DAY', pages: 2.5,
    desc: 'ETHEL hits top speed: 34mph on the dual carriageway. ARNOLD\'s dog hangs out the window in pure ecstasy.',
    content: `The 1992 beige Ford Fiesta on the dual carriageway. Six occupants. Four duffel bags. One basset hound.

BRUCE has his head out of the rear window. Ears flapping. Eyes closed in pure animal joy. ARNOLD watches him with great contentment.

ETHEL reaches 34mph. This is, for the Fiesta, something approaching full throttle.

DORIS
Can we go faster?

ETHEL
This is as fast as she goes.

GERALD
This is a getaway vehicle.

ETHEL
It's a 1992 Fiesta with 180,000 miles on it. It's not the Batmobile.

BARBARA's feathered hat takes up approximately a quarter of the interior. NORMAN's knee is pressed against the door. DORIS keeps checking the A-to-Z.

NORMAN
Are we being followed?

Everyone looks out the rear window. Traffic flows normally. Nothing out of the ordinary. A LORRY overtakes them with visible impatience.

GERALD
I don't think anyone saw us.

DORIS
The security camera saw us.

GERALD
(pause)
I knocked it sideways.

DORIS
With what?

GERALD
With BARBARA's hat. On the way in.

BARBARA
(genuinely pleased)
I told you it was a distraction.

BRUCE withdraws his head from the window and looks around the car with great satisfaction. He licks ARNOLD's face.

ARNOLD
(to BRUCE)
Good boy, Bruce. Very good boy.`,
  },
  {
    n: '16', intExt: 'EXT', location: 'MOTORWAY - LAY-BY', tod: 'DAY', pages: 1.5,
    desc: 'The Fiesta breaks down. The police drive straight past them at 90mph. Three times.',
    content: `A motorway lay-by. The 1992 beige Ford Fiesta parked, bonnet up. A faint smell of burning.

ETHEL stands looking at the engine. She doesn't touch anything.

ETHEL
It's the alternator.

DORIS
How do you know?

ETHEL
Same thing happened in 1994. And 1998. And once in Portugal.

A POLICE CAR screams past on the motorway at 90mph. Then another. Then a third.

The occupants of the Fiesta watch them go.

GERALD
Do you think that's for us?

DORIS
They didn't stop.

GERALD
They might come back.

DORIS
They didn't slow down.

ARNOLD
(eating a sandwich he has produced from nowhere)
I like motorway lay-bys. Very peaceful.

DORIS stands very still. Then very slowly, she begins to laugh. It surprises her. It surprises everyone.

ETHEL
What?

DORIS
Nothing. Just — look at us.

They look at each other. Four duffel bags of cash in a broken-down Fiesta on a motorway. BRUCE asleep in the boot. BARBARA's feathered hat pressed against the rear window.

It is, from a certain angle, magnificent.`,
  },
  {
    n: '17', intExt: 'INT', location: 'POLICE STATION', tod: 'DAY', pages: 3,
    desc: 'DCI BARNACLE interviews the crew one by one. Each gives a completely different account. All of them are implausible. None can be disproved.',
    content: `An interview room. A table, two chairs, and a coffee machine that appears to produce warm beige liquid. A one-way mirror runs along one wall.

DCI BARNACLE (60s, moustache like a disappointed caterpillar) sits across from DORIS. He has a notepad. He has not written anything on it yet.

DCI BARNACLE
So, Mrs — Doris. Can you describe your movements on Tuesday morning?

DORIS
I was at the community centre.

DCI BARNACLE
The community centre has been closed for three months.

DORIS
I was checking on it. For sentimental reasons.

DCI BARNACLE
Witnesses place a beige Ford Fiesta in the vicinity of First National Bank at approximately eleven-fifteen AM.

DORIS
Lots of beige Fiestas about.

DCI BARNACLE
This one had a basset hound.

DORIS
Lots of basset hounds too.

DCI BARNACLE stares at her. DORIS stares back. Neither blinks.

CUT TO:

GERALD in the same chair.

DCI BARNACLE
Your colleague says she was at the community centre.

GERALD
I was at the shops.

DCI BARNACLE
The shops.

GERALD
B&Q. Looking at drill bits.

CUT TO:

BARBARA.

DCI BARNACLE
The witness says a very large hat —

BARBARA
Lots of large hats about these days.

DCI BARNACLE
Peacock blue, feathered, approximately—

BARBARA
(perfectly pleasantly)
Are you accusing my hat of something, Inspector?

CUT TO:

ARNOLD.

DCI BARNACLE
Were you in the town centre on Tuesday?

ARNOLD
(hearing nothing correctly)
What? No, I don't want to see a dentist, thank you.

DCI BARNACLE looks at his notepad. He has written one word: "hats."

He crosses it out.`,
  },
  {
    n: '18', intExt: 'INT', location: 'BINGO HALL', tod: 'NIGHT', pages: 2,
    desc: 'Victory. The community centre is saved. There is dancing. GERALD attempts the worm. Paramedics are called.',
    content: `The bingo hall, transformed. Bunting. Good lighting. Bingo cards arranged on the tables like place settings at a wedding. Someone has polished the urn of tea.

The whole crew: DORIS, GERALD, ETHEL, NORMAN, BARBARA, ARNOLD. And assorted friends, neighbours, regulars.

Music. Someone has connected a phone to a speaker. It is playing something cheerfully inappropriate.

DORIS stands back from it all and watches.

BARBARA
(appearing at her shoulder)
We actually did it.

DORIS
We actually did.

BARBARA
Are you going to dance?

DORIS
Absolutely not.

BARBARA dances away regardless, feathered hat at a rakish angle.

ETHEL is in conversation with someone DORIS doesn't recognise. NORMAN is showing a young person his Nokia and they are looking at each other with mutual incomprehension.

GERALD approaches. Loosened tie. Expression of a man who has decided this is the night.

GERALD
I'm going to do the worm.

DORIS
Please don't.

GERALD
It's a celebration.

DORIS
Gerald, you have a hip replacement.

GERALD
I've practised.

Beat.

DORIS
When did you practise the worm?

GERALD
The last six months. I thought this might happen eventually.

GERALD attempts the worm. It begins well and ends with a sound that makes ARNOLD's dog look up sharply. BRUCE pads over to inspect.

Some time later, two PARAMEDICS are in the corner with GERALD.

PARAMEDIC
Can you feel your legs?

GERALD
(cheerfully)
Not especially. It was worth it.`,
  },
  {
    n: '19', intExt: 'EXT', location: 'SEASIDE PROMENADE', tod: 'DAY', pages: 1.5,
    desc: 'The crew walk along the seafront with chips. DORIS drops hers to a seagull. She is not even upset.',
    content: `A grey, bright day. The seafront. Waves. Chips in paper cones.

DORIS, GERALD, ETHEL, NORMAN, BARBARA, and ARNOLD walk along the promenade. BRUCE trots ahead, nose to the ground.

NORMAN
I've been thinking about what comes next.

ETHEL
Retirement.

NORMAN
We just robbed a bank, Ethel. I don't think retirement covers it.

BARBARA
(eating chips)
I'm thinking about the hat. Whether it should be in a museum.

GERALD
It should absolutely not be in a museum.

BARBARA
One of those costume ones. Film history.

A SEAGULL swoops and takes three chips from DORIS's cone in a single pass.

DORIS looks at the empty cone. Then at the seagull, who has landed on a railing and is eating with great satisfaction.

DORIS
(after a moment)
Good for him.

She continues walking. No replacement chips. No complaint.

ETHEL
You're not upset?

DORIS
He was hungry. It was his chips.

A beat.

ARNOLD
(to BRUCE, quietly)
Don't get any ideas.

BRUCE pretends not to hear.`,
  },
  {
    n: '20', intExt: 'EXT', location: 'BINGO HALL', tod: 'NIGHT', pages: 1,
    desc: 'The hall is lit up. The sign reads: GRAND REOPENING. DORIS drives away. She does not look back. (She does look back.)',
    content: `Night. The bingo hall. A hand-painted sign in the window: GRAND REOPENING — THIS SATURDAY.

Inside, through the lit windows: bingo cards laid out on tables. Daubers in cups. An urn of tea warming in the corner.

DORIS sits in the passenger seat of a car we haven't seen before. Better than the Fiesta. Slightly.

She looks at the hall.

She has seen this building a thousand times. Danced here. Argued here. Sat in silence here on difficult Thursdays. Watched it nearly disappear.

She nods once. To no one.

The car pulls away.

DORIS does not look back.

A beat.

She looks back.

The hall glows in the rear window. Then it's gone round the corner.

DORIS turns forward again.

DORIS
(very quietly)
Right then.

FADE OUT.`,
  },
]

const sceneRows = await db.insert(scenes).values(
  SCENES.map((s, i) => ({
    projectId,
    sceneNumber: s.n,
    intExt: s.intExt,
    location: s.location,
    timeOfDay: s.tod,
    description: s.desc,
    content: s.content || '',
    pages: s.pages,
    sortOrder: i,
  }))
).returning()
console.log(`Created ${sceneRows.length} scenes`)

// ── Breakdown elements ────────────────────────────────────────────────────────
const sceneById = Object.fromEntries(sceneRows.map(s => [s.sceneNumber, s.id]))

const ELEMENTS = [
  // Scene 1 — INT. BINGO HALL - DAY
  { scene: '1', cat: 'cast',         desc: 'DORIS' },
  { scene: '1', cat: 'cast',         desc: 'GERALD' },
  { scene: '1', cat: 'cast',         desc: 'ETHEL' },
  { scene: '1', cat: 'cast',         desc: 'NORMAN' },
  { scene: '1', cat: 'cast',         desc: 'BARBARA' },
  { scene: '1', cat: 'cast',         desc: 'ARNOLD' },
  { scene: '1', cat: 'props',        desc: 'bingo cards' },
  { scene: '1', cat: 'props',        desc: 'daubers' },
  { scene: '1', cat: 'set_dressing', desc: 'folding tables' },
  { scene: '1', cat: 'props',        desc: 'urn of tea' },
  // Scene 2 — INT. DORIS'S KITCHEN - NIGHT
  { scene: '2', cat: 'cast',  desc: 'DORIS' },
  { scene: '2', cat: 'cast',  desc: 'GERALD' },
  { scene: '2', cat: 'cast',  desc: 'ETHEL' },
  { scene: '2', cat: 'cast',  desc: 'NORMAN' },
  { scene: '2', cat: 'cast',  desc: 'BARBARA' },
  { scene: '2', cat: 'props', desc: 'paper napkin' },
  { scene: '2', cat: 'props', desc: 'teapot' },
  { scene: '2', cat: 'props', desc: 'biscuits' },
  // Scene 3 — EXT. FIRST NATIONAL BANK - DAY
  { scene: '3', cat: 'cast',     desc: 'DORIS' },
  { scene: '3', cat: 'cast',     desc: 'ETHEL' },
  { scene: '3', cat: 'cast',     desc: 'GERALD' },
  { scene: '3', cat: 'vehicles', desc: '1992 beige Ford Fiesta' },
  // Scene 4 — INT. SHOPPING MALL - DAY
  { scene: '4', cat: 'cast',    desc: 'DORIS' },
  { scene: '4', cat: 'cast',    desc: 'BARBARA' },
  { scene: '4', cat: 'costume', desc: 'feathered hat' },
  // Scene 5 — INT. GERALD'S GARAGE - NIGHT
  { scene: '5', cat: 'cast',          desc: 'GERALD' },
  { scene: '5', cat: 'special_props', desc: 'modified leaf blower' },
  { scene: '5', cat: 'set_dressing',  desc: 'tool bench' },
  { scene: '5', cat: 'props',         desc: 'safety goggles' },
  // Scene 6 — EXT. MUNICIPAL PARK - DAY
  { scene: '6', cat: 'cast',     desc: 'ETHEL' },
  { scene: '6', cat: 'cast',     desc: 'DORIS' },
  { scene: '6', cat: 'cast',     desc: 'ARNOLD' },
  { scene: '6', cat: 'vehicles', desc: '1992 beige Ford Fiesta' },
  { scene: '6', cat: 'animals',  desc: 'BRUCE' },
  // Scene 7 — INT. FIRST NATIONAL BANK - DAY
  { scene: '7', cat: 'cast', desc: 'NORMAN' },
  { scene: '7', cat: 'cast', desc: 'YOUNG TELLER' },
  { scene: '7', cat: 'cast', desc: 'BANK MANAGER' },
  { scene: '7', cat: 'cast', desc: 'SECURITY GUARD' },
  // Scene 8 — INT. BINGO HALL - NIGHT
  { scene: '8', cat: 'cast',    desc: 'DORIS' },
  { scene: '8', cat: 'cast',    desc: 'GERALD' },
  { scene: '8', cat: 'cast',    desc: 'ETHEL' },
  { scene: '8', cat: 'cast',    desc: 'NORMAN' },
  { scene: '8', cat: 'cast',    desc: 'BARBARA' },
  { scene: '8', cat: 'cast',    desc: 'ARNOLD' },
  { scene: '8', cat: 'animals', desc: 'BRUCE' },
  { scene: '8', cat: 'props',   desc: 'bingo cards' },
  { scene: '8', cat: 'props',   desc: 'daubers' },
  // Scene 9 — INT. BEDROOM - DORIS'S HOUSE - NIGHT
  { scene: '9', cat: 'cast', desc: 'DORIS' },
  // Scene 10 — EXT. RESIDENTIAL STREET - DAY
  { scene: '10', cat: 'cast',     desc: 'DORIS' },
  { scene: '10', cat: 'cast',     desc: 'GERALD' },
  { scene: '10', cat: 'cast',     desc: 'ETHEL' },
  { scene: '10', cat: 'cast',     desc: 'NORMAN' },
  { scene: '10', cat: 'cast',     desc: 'BARBARA' },
  { scene: '10', cat: 'cast',     desc: 'ARNOLD' },
  { scene: '10', cat: 'vehicles', desc: '1992 beige Ford Fiesta' },
  { scene: '10', cat: 'animals',  desc: 'BRUCE' },
  // Scene 11 — INT. FIRST NATIONAL BANK - DAY (THE HEIST)
  { scene: '11', cat: 'cast',          desc: 'DORIS' },
  { scene: '11', cat: 'cast',          desc: 'GERALD' },
  { scene: '11', cat: 'cast',          desc: 'ETHEL' },
  { scene: '11', cat: 'cast',          desc: 'NORMAN' },
  { scene: '11', cat: 'cast',          desc: 'BARBARA' },
  { scene: '11', cat: 'cast',          desc: 'ARNOLD' },
  { scene: '11', cat: 'cast',          desc: 'BANK MANAGER' },
  { scene: '11', cat: 'cast',          desc: 'YOUNG TELLER' },
  { scene: '11', cat: 'cast',          desc: 'SECURITY GUARD' },
  { scene: '11', cat: 'animals',       desc: 'BRUCE' },
  { scene: '11', cat: 'costume',       desc: 'feathered hat' },
  { scene: '11', cat: 'props',         desc: 'duffel bags' },
  { scene: '11', cat: 'special_props', desc: 'paper napkin' },
  { scene: '11', cat: 'extras',        desc: '12 bank customers (BG)' },
  // Scene 12 — INT. BANK VAULT - DAY
  { scene: '12', cat: 'cast',         desc: 'GERALD' },
  { scene: '12', cat: 'cast',         desc: 'DORIS' },
  { scene: '12', cat: 'set_dressing', desc: 'vault door' },
  { scene: '12', cat: 'set_dressing', desc: 'stacked cash trays' },
  { scene: '12', cat: 'props',        desc: 'duffel bags' },
  { scene: '12', cat: 'props',        desc: 'stethoscope' },
  // Scene 13 — INT. FIRST NATIONAL BANK - DAY (CHASE)
  { scene: '13', cat: 'cast',   desc: 'SECURITY GUARD' },
  { scene: '13', cat: 'cast',   desc: 'GERALD' },
  { scene: '13', cat: 'cast',   desc: 'ETHEL' },
  { scene: '13', cat: 'cast',   desc: 'BARBARA' },
  { scene: '13', cat: 'cast',   desc: 'ARNOLD' },
  { scene: '13', cat: 'stunts', desc: 'GERALD trips over walking frame' },
  { scene: '13', cat: 'props',  desc: 'walking frame' },
  // Scene 14 — EXT. FIRST NATIONAL BANK - DAY (GETAWAY)
  { scene: '14', cat: 'cast',     desc: 'DORIS' },
  { scene: '14', cat: 'cast',     desc: 'ETHEL' },
  { scene: '14', cat: 'cast',     desc: 'GERALD' },
  { scene: '14', cat: 'cast',     desc: 'BARBARA' },
  { scene: '14', cat: 'cast',     desc: 'ARNOLD' },
  { scene: '14', cat: 'cast',     desc: 'NORMAN' },
  { scene: '14', cat: 'vehicles', desc: '1992 beige Ford Fiesta' },
  { scene: '14', cat: 'props',    desc: '2009 A-to-Z' },
  // Scene 15 — INT. FORD FIESTA - MOVING - DAY
  { scene: '15', cat: 'cast',     desc: 'DORIS' },
  { scene: '15', cat: 'cast',     desc: 'GERALD' },
  { scene: '15', cat: 'cast',     desc: 'ETHEL' },
  { scene: '15', cat: 'cast',     desc: 'NORMAN' },
  { scene: '15', cat: 'cast',     desc: 'BARBARA' },
  { scene: '15', cat: 'cast',     desc: 'ARNOLD' },
  { scene: '15', cat: 'vehicles', desc: '1992 beige Ford Fiesta' },
  { scene: '15', cat: 'animals',  desc: 'BRUCE' },
  // Scene 16 — EXT. MOTORWAY LAY-BY - DAY
  { scene: '16', cat: 'cast',     desc: 'DORIS' },
  { scene: '16', cat: 'cast',     desc: 'ETHEL' },
  { scene: '16', cat: 'cast',     desc: 'GERALD' },
  { scene: '16', cat: 'cast',     desc: 'BARBARA' },
  { scene: '16', cat: 'cast',     desc: 'ARNOLD' },
  { scene: '16', cat: 'cast',     desc: 'NORMAN' },
  { scene: '16', cat: 'vehicles', desc: '1992 beige Ford Fiesta' },
  { scene: '16', cat: 'animals',  desc: 'BRUCE' },
  // Scene 17 — INT. POLICE STATION - DAY
  { scene: '17', cat: 'cast',         desc: 'DCI BARNACLE' },
  { scene: '17', cat: 'cast',         desc: 'DORIS' },
  { scene: '17', cat: 'cast',         desc: 'GERALD' },
  { scene: '17', cat: 'cast',         desc: 'ETHEL' },
  { scene: '17', cat: 'cast',         desc: 'NORMAN' },
  { scene: '17', cat: 'cast',         desc: 'BARBARA' },
  { scene: '17', cat: 'cast',         desc: 'ARNOLD' },
  { scene: '17', cat: 'set_dressing', desc: 'one-way mirror' },
  { scene: '17', cat: 'set_dressing', desc: 'interview room table' },
  { scene: '17', cat: 'props',        desc: 'coffee machine' },
  // Scene 18 — INT. BINGO HALL - NIGHT (VICTORY)
  { scene: '18', cat: 'cast',   desc: 'DORIS' },
  { scene: '18', cat: 'cast',   desc: 'GERALD' },
  { scene: '18', cat: 'cast',   desc: 'ETHEL' },
  { scene: '18', cat: 'cast',   desc: 'NORMAN' },
  { scene: '18', cat: 'cast',   desc: 'BARBARA' },
  { scene: '18', cat: 'cast',   desc: 'ARNOLD' },
  { scene: '18', cat: 'stunts', desc: 'GERALD attempts the worm' },
  { scene: '18', cat: 'props',  desc: 'bingo cards' },
  { scene: '18', cat: 'props',  desc: 'daubers' },
  // Scene 19 — EXT. SEASIDE PROMENADE - DAY
  { scene: '19', cat: 'cast',    desc: 'DORIS' },
  { scene: '19', cat: 'cast',    desc: 'GERALD' },
  { scene: '19', cat: 'cast',    desc: 'ETHEL' },
  { scene: '19', cat: 'cast',    desc: 'NORMAN' },
  { scene: '19', cat: 'cast',    desc: 'BARBARA' },
  { scene: '19', cat: 'cast',    desc: 'ARNOLD' },
  { scene: '19', cat: 'animals', desc: 'BRUCE' },
  // Scene 20 — EXT. BINGO HALL - NIGHT
  { scene: '20', cat: 'cast', desc: 'DORIS' },
]

const elemValues = ELEMENTS
  .filter(e => sceneById[e.scene])
  .map((e, i) => ({
    sceneId: sceneById[e.scene],
    projectId,
    category: e.cat,
    description: e.desc,
    sortOrder: i,
  }))
await db.insert(breakdownElements).values(elemValues)
console.log(`Created ${elemValues.length} breakdown elements`)

// ── Shoot day events ──────────────────────────────────────────────────────────
// 5 shoot days across July 2026, each with a handful of scenes
const SHOOT_DAYS = [
  { date: '2026-07-07', title: 'Shoot Day 1 — Bingo Hall & Kitchen', sceneNums: ['1', '2', '8', '18'] },
  { date: '2026-07-08', title: 'Shoot Day 2 — Bank Recon & Gear Up', sceneNums: ['3', '7', '5', '4'] },
  { date: '2026-07-10', title: 'Shoot Day 3 — Practice & Night Prep', sceneNums: ['6', '9', '10'] },
  { date: '2026-07-14', title: 'Shoot Day 4 — THE HEIST', sceneNums: ['11', '12', '13', '14'] },
  { date: '2026-07-15', title: 'Shoot Day 5 — Chase, Aftermath & Ending', sceneNums: ['15', '16', '17', '19', '20'] },
]

for (const sd of SHOOT_DAYS) {
  const [ev] = await db.insert(events).values({
    projectId,
    type: 'shoot_day',
    title: sd.title,
    date: sd.date,
    startTime: '08:00',
    endTime: '20:00',
    location: 'Various (see breakdown)',
    locationType: 'in_person',
    createdAt: now,
  }).returning()

  const scIds = sd.sceneNums.map(n => sceneById[n]).filter(Boolean)
  if (scIds.length) {
    await db.insert(eventScenes).values(scIds.map(sceneId => ({ eventId: ev.id, sceneId })))
  }
}
console.log(`Created ${SHOOT_DAYS.length} shoot day events`)

// ── Done ──────────────────────────────────────────────────────────────────────
console.log('\n✓ Seed complete!')
console.log(`  Project: "The Last Withdrawal" (id ${projectId})`)
console.log(`  Open it at: http://localhost:3000`)
process.exit(0)
