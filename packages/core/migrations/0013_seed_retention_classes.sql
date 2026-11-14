INSERT INTO "retention_class" ("key", "description", "anchor") VALUES
	('standard', 'Ordinary production records', 'project-delivery'),
	('financial-record', 'Cost lines, invoices, budgets, financing, compliance data', 'first-exploitation'),
	('contract', 'Contracts registry', 'first-exploitation'),
	('crew-personal', 'Identity, financial and representation data of people', 'project-wrap'),
	('crew-health', 'Dietary, medical, accessibility and emergency data', 'project-wrap'),
	('minor-record', 'Minors'' permits and logs', 'project-wrap'),
	('security-log', 'Audit rows holding IP addresses', 'record-created');
