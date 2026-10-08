import { createHash } from 'node:crypto';
import standardProfiles from '../../../seed/users.json' with { type: 'json' };
import vipProfiles from '../../../seed/vip.json' with { type: 'json' };
import { QUESTION_POOL } from './questions';

export interface SeedUser {
  username: string;
  email: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  department: string;
  title: string;
  phone_last4: string;
  is_vip: boolean;
  is_locked: boolean;
  questions: { key: string; text: string; answer: string; position: 1 | 2 | 3 }[];
  vip?: {
    pin: string;
    executive_assistant_name: string;
    assistant_phone_last4: string;
    callback_phone_last4: string;
    concierge_queue: 'executive-support';
  };
}

export interface SeedTicket {
  username: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  category: string;
  summary: string;
  status: string;
  created_at: string;
}

export interface SeedData {
  users: SeedUser[];
  tickets: SeedTicket[];
}

const ANSWERS: Record<string, string[]> = {
  first_pet: ['Biscuit', 'Mr. Whiskers', 'Pepper', 'Shadow', 'Coco', 'Bandit', 'Oreo', 'Peanut', 'Rocky', 'Captain Jack', 'Ziggy', 'Mittens'],
  childhood_street: ['Maple Avenue', 'Elm Street', 'Cedar Lane', 'Willow Creek Road', 'Chestnut Court', 'Magnolia Drive',
    'Harbor View Terrace', 'Birch Hollow Road', 'Sycamore Street', 'Old Mill Road', 'Juniper Way', 'Prospect Hill Avenue'],
  mother_maiden: ["O'Brien", 'Kowalczyk', 'Fitzgerald', 'Nakamura', 'Delacroix', 'MacDonald', 'Okonkwo', 'Rossi', 'Gallagher',
    'Lindgren', 'Santiago', "D'Angelo"],
  first_car: ['Honda Civic', 'Toyota Corolla', 'Ford Escort', 'Chevy Cavalier', 'Jeep Wrangler', 'Nissan Sentra', 'Subaru Outback',
    'Mazda Miata', 'Dodge Neon', 'Volvo 240', 'Pontiac Grand Am', 'Volkswagen Jetta'],
  favorite_teacher: ['Patterson', 'McAllister', 'Delgado', 'Fujimoto', "O'Malley", 'Thornton', 'Abernathy', 'Kaplan', 'Whitmore',
    'Gutierrez', 'Castillo', 'Hendricks'],
  birth_city: ['St. Louis', 'Chicago', 'San Antonio', 'Fort Worth', 'Baton Rouge', 'Salt Lake City', 'Des Moines', 'Pittsburgh',
    'Albuquerque', 'Ann Arbor', 'Sacramento', 'Providence'],
  first_employer: ["McDonald's", 'Dairy Queen', 'Kroger', 'Blockbuster Video', 'Pizza Hut', 'Target', 'Walgreens', 'Six Flags',
    'Ace Hardware', 'Sears', 'Piggly Wiggly', "Dunkin' Donuts"],
  best_friend: ['Jessica', 'Tommy', 'Alejandro', 'Keisha', 'Bobby', 'Sarah Beth', 'Danny', 'Priyanka', 'Connor', 'Lupe', 'Wendell',
    'Mary Kate'],
  hs_mascot: ['Wildcats', 'Bulldogs', 'Golden Eagles', 'Spartans', 'Blue Devils', 'Mustangs', 'Fighting Irish', 'Trojans', 'Panthers',
    'Red Raiders', 'Knights', 'Hornets'],
  first_concert: ['Bon Jovi', 'Backstreet Boys', 'Garth Brooks', 'Prince', 'Madonna', 'U2', 'Dave Matthews Band', 'Taylor Swift',
    "Destiny's Child", 'Def Leppard', 'Fleetwood Mac', 'Green Day'],
};

type TicketTemplate = [priority: SeedTicket['priority'], category: string, summary: string];

const VIP_TICKETS: TicketTemplate[] = [
  ['P2', 'email', 'Executive assistant needs delegate access to the calendar'],
  ['P2', 'hardware', 'Boardroom display will not mirror from the laptop'],
  ['P3', 'software', 'Board portal app crashes on the iPad after an update'],
];

const STAFF_TICKETS: TicketTemplate[] = [
  ['P3', 'hardware', 'Laptop battery drains in under an hour'],
  ['P3', 'hardware', 'Docking station does not detect the second monitor'],
  ['P4', 'hardware', 'Replacement headset needed for softphone calls'],
  ['P2', 'hardware', 'Desktop workstation will not power on'],
  ['P3', 'software', 'Excel crashes when opening a large spreadsheet'],
  ['P4', 'software', 'Request to install Visio for process mapping'],
  ['P3', 'software', 'Teams does not detect the laptop camera'],
  ['P2', 'software', 'PDF editor shows a license error'],
  ['P3', 'network', 'VPN disconnects every few minutes when working from home'],
  ['P3', 'network', 'Wi-Fi drops in the third floor conference room'],
  ['P2', 'network', 'Shared drive is unreachable after connecting to the VPN'],
  ['P4', 'network', 'Guest Wi-Fi access needed for a visiting auditor'],
  ['P3', 'access', 'Need access to the department shared drive'],
  ['P2', 'access', 'Badge does not open the parking garage door'],
  ['P3', 'access', 'MFA prompts are not arriving on a new phone'],
  ['P3', 'email', 'Outlook keeps asking for a password'],
  ['P4', 'email', 'Shared mailbox is missing from Outlook'],
  ['P3', 'email', 'Reported a suspicious email as phishing'],
  ['P4', 'email', 'Add a new hire to the team distribution list'],
  ['P3', 'printing', 'Cannot print to the second floor printer'],
  ['P4', 'printing', 'Badge release printing does not pick up jobs'],
  ['P3', 'printing', 'Label printer prints blank labels'],
];

function rngFor(key: string): () => number {
  let a = createHash('sha256').update(`voice-service-desk-seed:${key}`).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

function questionsFor(rng: () => number): SeedUser['questions'] {
  const pool = [...QUESTION_POOL];
  return ([1, 2, 3] as const).map((position) => {
    const { key, text } = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    return { key, text, answer: pick(rng, ANSWERS[key]), position };
  });
}

export function buildSeedData(): SeedData {
  const users: SeedUser[] = [
    ...standardProfiles.map((p) => ({ ...p, is_vip: false, questions: questionsFor(rngFor(p.username)) })),
    ...vipProfiles.map(({ executive_assistant_name, assistant_phone_last4, callback_phone_last4, ...p }): SeedUser => {
      const rng = rngFor(p.username);
      return {
        ...p,
        is_vip: true,
        questions: questionsFor(rng),
        vip: {
          pin: String(Math.floor(rng() * 1e6)).padStart(6, '0'),
          executive_assistant_name,
          assistant_phone_last4,
          callback_phone_last4,
          concierge_queue: 'executive-support',
        },
      };
    }),
  ];
  const rng = rngFor('tickets');
  const owners = (vip: boolean) => users.filter((u) => u.is_vip === vip).map((u) => u.username).sort();
  const ticket = (usernames: string[]) => ([priority, category, summary]: TicketTemplate): SeedTicket => {
    const daysAgo = Math.floor(rng() * 45);
    return {
      username: pick(rng, usernames),
      priority,
      category,
      summary,
      status: pick(rng, daysAgo < 15 ? ['open', 'in_progress', 'waiting_on_user'] : ['resolved', 'closed']),
      created_at: new Date(Date.UTC(2026, 8, 30 - daysAgo, 13 + Math.floor(rng() * 9), Math.floor(rng() * 60))).toISOString(),
    };
  };
  const tickets = [...VIP_TICKETS.map(ticket(owners(true))), ...STAFF_TICKETS.map(ticket(owners(false)))];
  return { users, tickets: tickets.sort((a, b) => a.created_at.localeCompare(b.created_at)) };
}
