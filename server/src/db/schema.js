import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'crew'] }).notNull().default('crew'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  genre: text('genre'),
  format: text('format'),
  status: text('status').notNull().default('development'),
  description: text('description'),
  createdBy: integer('created_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const departments = sqliteTable('departments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  name: text('name').notNull(),
  icon: text('icon').notNull().default('📁'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const coproducers = sqliteTable('coproducers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  name: text('name').notNull(),
  sharePercent: real('share_percent').notNull().default(0),
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const budgetTemplateCategories = sqliteTable('budget_template_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  section: text('section').notNull().default('below_the_line'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const budgetCategories = sqliteTable('budget_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  name: text('name').notNull(),
  section: text('section').notNull().default('below_the_line'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const budgetLines = sqliteTable('budget_lines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  categoryId: integer('category_id').notNull(),
  projectId: integer('project_id').notNull(),
  description: text('description').notNull().default(''),
  qty: real('qty').notNull().default(1),
  unit: text('unit').notNull().default('flat'),
  rate: real('rate').notNull().default(0),
  total: real('total').notNull().default(0),
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const crewMembers = sqliteTable('crew_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  type: text('type').notNull().default('crew'),            // 'cast' | 'crew'
  name: text('name').notNull(),
  email: text('email').default(''),
  phone: text('phone').default(''),
  role: text('role').notNull().default(''),                // job title / character
  characterName: text('character_name').default(''),       // cast only
  departmentId: integer('department_id'),                  // crew only, nullable FK
  agentName: text('agent_name').default(''),
  agentEmail: text('agent_email').default(''),
  agentPhone: text('agent_phone').default(''),
  emergencyName: text('emergency_name').default(''),
  emergencyPhone: text('emergency_phone').default(''),
  emergencyRelation: text('emergency_relation').default(''),
  pronouns: text('pronouns').default(''),
  dietaryNeeds: text('dietary_needs').default(''),
  medicalNeeds: text('medical_needs').default(''),
  accessibilityNeeds: text('accessibility_needs').default(''),
  startDate: text('start_date').default(''),
  endDate: text('end_date').default(''),
  notes: text('notes').default(''),
  status: text('status').notNull().default('pending'),
  userId: integer('user_id'),
  onboardingToken: text('onboarding_token'),
  onboardingTokenExpires: integer('onboarding_token_expires'), // ms since epoch
  onboardingCompletedAt: integer('onboarding_completed_at', { mode: 'timestamp' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const scripts = sqliteTable('scripts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  filename: text('filename').notNull().default(''),
  rawContent: text('raw_content').notNull().default(''),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
})

export const scenes = sqliteTable('scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  sceneNumber: text('scene_number').notNull(),
  intExt: text('int_ext').notNull().default('INT'),
  location: text('location').notNull().default(''),
  timeOfDay: text('time_of_day').notNull().default('DAY'),
  description: text('description').notNull().default(''),
  content: text('content').default(''),
  pages: real('pages').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const breakdownElements = sqliteTable('breakdown_elements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sceneId: integer('scene_id').notNull(),
  projectId: integer('project_id').notNull(),
  category: text('category').notNull(),
  description: text('description').notNull().default(''),
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const invoices = sqliteTable('invoices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  budgetLineId: integer('budget_line_id'),
  vendor: text('vendor').notNull().default(''),
  invoiceNumber: text('invoice_number').default(''),
  invoiceDate: text('invoice_date').default(''),
  amount: real('amount').notNull().default(0),
  status: text('status').notNull().default('pending'),
  description: text('description').default(''),
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
