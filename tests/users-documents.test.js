'use strict';

const fs = require('fs');
const request = require('supertest');
const { createWorld } = require('./harness');

let w;
let staffClient;
let seq = 0;
beforeAll(async () => {
  w = await createWorld();
  staffClient = await w.login(w.staff);
});
afterAll(() => w.close());

const nextEmail = () => `new.customer${++seq}@vault24.test`;

function register(client, { fields = {}, file = w.pdf('Jane Mwangi'), filename = 'national-id.pdf', contentType = 'application/pdf' } = {}) {
  const req = client.multipart('/api/staff/customers');
  const f = { full_name: 'Jane Mwangi', email: nextEmail(), phone_number: '+260 971 000001', ...fields };
  for (const [k, v] of Object.entries(f)) req.field(k, v);
  if (file) req.attach('identity_document', file, { filename, contentType });
  return req;
}

const storedFiles = () => fs.readdirSync(w.storageDir);

describe('Staff customer registration', () => {
  test('staff can register a customer with a synthetic PDF', async () => {
    const res = await register(staffClient);
    expect(res.status).toBe(201);
    expect(res.body.customer).toMatchObject({ role: 'customer', status: 'active', verification_status: 'pending', created_by: w.staff.id });
    expect(res.body.document).toMatchObject({ verification_status: 'pending', mime_type: 'application/pdf', original_filename: 'national-id.pdf' });
    expect(res.body.temporary_password).toMatch(/^[\w-]{19}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/storage_key|password_hash|argon2/);

    const row = w.db.prepare('SELECT must_change_password, created_by FROM users WHERE id = ?').get(res.body.customer.id);
    expect(row).toEqual({ must_change_password: 1, created_by: w.staff.id });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.register' AND outcome = 'success' AND target_id = ?")
      .get(String(res.body.customer.id)).n).toBe(1);
  });

  test('the new customer can log in with the temporary password and must change it', async () => {
    const res = await register(staffClient);
    const c = await w.anonymous();
    const login = await c.post('/api/auth/login', { email: res.body.customer.email, password: res.body.temporary_password });
    expect(login.status).toBe(200);
    expect(login.body.must_change_password).toBe(true);
  });

  test('the stored file has a random name and identical bytes; the original name is not on disk', async () => {
    const before = new Set(storedFiles());
    const pdf = w.pdf('Disk Check');
    const res = await register(staffClient, { file: pdf, filename: '../../etc/passwd.pdf' });
    expect(res.status).toBe(201);
    const added = storedFiles().filter((f) => !before.has(f));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(`${w.storageDir}/${added[0]}`).equals(pdf)).toBe(true);
    expect(res.body.document.original_filename).toBe('passwd.pdf');
  });

  test('created_by always comes from the session, never the request', async () => {
    const res = await register(staffClient, { fields: { created_by: String(w.admin.id) } });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(/created_by/);
  });

  test.each(['role', 'status', 'verification_status'])('a client-supplied %s field is rejected', async (field) => {
    const res = await register(staffClient, { fields: { [field]: 'admin' } });
    expect(res.status).toBe(400);
  });

  test('unauthenticated visitors cannot register customers', async () => {
    const anon = await w.anonymous();
    expect((await register(anon)).status).toBe(401);
  });

  test('customers cannot register customers', async () => {
    const customer = await w.login(w.addUser());
    expect((await register(customer)).status).toBe(403);
  });

  test('admins cannot use the staff-only registration route', async () => {
    const admin = await w.login(w.admin);
    expect((await register(admin)).status).toBe(403);
  });

  test('a duplicate email fails safely with 409 and leaves no orphaned file', async () => {
    const email = nextEmail();
    expect((await register(staffClient, { fields: { email } })).status).toBe(201);
    const filesBefore = storedFiles().length;
    const dup = await register(staffClient, { fields: { email: email.toUpperCase() } });
    expect(dup.status).toBe(409);
    expect(storedFiles().length).toBe(filesBefore);
  });

  test('a missing identity document prevents registration', async () => {
    const email = nextEmail();
    const res = await register(staffClient, { fields: { email }, file: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDENTITY_DOCUMENT_REQUIRED');
    expect(w.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)).toBeUndefined();
  });

  test('a text file renamed to .pdf with a PDF MIME type is rejected by signature', async () => {
    const res = await register(staffClient, { file: Buffer.from('just some text pretending to be a pdf'), filename: 'id.pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DOCUMENT');
  });

  test('a PNG disguised as a PDF is rejected', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
    expect((await register(staffClient, { file: png, filename: 'id.pdf' })).status).toBe(400);
  });

  test('a real PDF with a non-PDF extension or MIME type is rejected', async () => {
    expect((await register(staffClient, { filename: 'id.exe' })).status).toBe(400);
    expect((await register(staffClient, { contentType: 'text/html' })).status).toBe(400);
  });

  test('a PDF header without the %%EOF trailer is rejected', async () => {
    const truncated = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n'.padEnd(300, ' '));
    expect((await register(staffClient, { file: truncated })).status).toBe(400);
  });

  test('files above the 5 MB limit are rejected with 413', async () => {
    const big = Buffer.concat([w.pdf('Big'), Buffer.alloc(5 * 1024 * 1024 + 10, 0x20), Buffer.from('\n%%EOF\n')]);
    const res = await register(staffClient, { file: big });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('Document access and review', () => {
  let customer;
  let documentId;
  beforeAll(async () => {
    const res = await register(staffClient, { fields: { full_name: 'Grace Phiri' } });
    customer = res.body.customer;
    documentId = res.body.document.id;
  });

  test('staff can list a customer\'s documents without storage keys', async () => {
    const res = await staffClient.get(`/api/staff/customers/${customer.id}/documents`);
    expect(res.status).toBe(200);
    expect(res.body.documents[0].id).toBe(documentId);
    expect(JSON.stringify(res.body)).not.toMatch(/storage_key|private-documents|\/tmp\//);
  });

  test('staff and admins can download the PDF through the authorised route', async () => {
    const res = await staffClient.get(`/api/documents/${documentId}/download`).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    const admin = await w.login(w.admin);
    expect((await admin.get(`/api/documents/${documentId}/download`)).status).toBe(200);
  });

  test('a customer cannot download another customer\'s document', async () => {
    const other = await w.login(w.addUser());
    expect((await other.get(`/api/documents/${documentId}/download`)).status).toBe(403);
    expect((await other.get(`/api/staff/customers/${customer.id}/documents`)).status).toBe(403);
  });

  test('anonymous users cannot download documents', async () => {
    expect((await request(w.app).get(`/api/documents/${documentId}/download`)).status).toBe(401);
  });

  test('staff and customers cannot approve identity documents', async () => {
    expect((await staffClient.patch(`/api/admin/documents/${documentId}/review`, { decision: 'verified' })).status).toBe(403);
    const cust = await w.login(w.addUser());
    expect((await cust.patch(`/api/admin/documents/${documentId}/review`, { decision: 'verified' })).status).toBe(403);
    expect(w.db.prepare('SELECT verification_status FROM user_documents WHERE id = ?').get(documentId).verification_status).toBe('pending');
  });

  test('rejection requires a reason', async () => {
    const admin = await w.login(w.admin);
    expect((await admin.patch(`/api/admin/documents/${documentId}/review`, { decision: 'rejected' })).status).toBe(400);
  });

  test('an admin approval verifies the document and the customer, recording reviewer and time', async () => {
    const admin = await w.login(w.admin);
    const pending = await admin.get('/api/admin/documents?status=pending');
    expect(pending.body.documents.map((d) => d.id)).toContain(documentId);

    const res = await admin.patch(`/api/admin/documents/${documentId}/review`, { decision: 'verified' });
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ verification_status: 'verified', reviewed_by: w.admin.id });
    expect(res.body.document.reviewed_at).toMatch(/Z$/);
    expect(w.db.prepare('SELECT verification_status FROM users WHERE id = ?').get(customer.id).verification_status).toBe('verified');
    expect((await admin.patch(`/api/admin/documents/${documentId}/review`, { decision: 'rejected', rejection_reason: 'Too late' })).status).toBe(409);
  });

  test('rejecting marks the customer rejected; a new upload puts them back to pending', async () => {
    const reg = await register(staffClient, { fields: { full_name: 'Peter Banda' } });
    const admin = await w.login(w.admin);
    await admin.patch(`/api/admin/documents/${reg.body.document.id}/review`, { decision: 'rejected', rejection_reason: 'Image unreadable' });
    expect(w.db.prepare('SELECT verification_status FROM users WHERE id = ?').get(reg.body.customer.id).verification_status).toBe('rejected');

    const upload = await staffClient.multipart(`/api/staff/customers/${reg.body.customer.id}/documents`)
      .attach('identity_document', w.pdf('Peter Banda'), { filename: 'id-v2.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
    expect(upload.body.document.verification_status).toBe('pending');
    expect(w.db.prepare('SELECT verification_status FROM users WHERE id = ?').get(reg.body.customer.id).verification_status).toBe('pending');
  });
});

describe('Profile', () => {
  test('customers can view their profile and update only their phone number', async () => {
    const user = w.addUser();
    const c = await w.login(user);
    expect((await c.get('/api/profile')).body.profile.email).toBe(user.email);
    const ok = await c.patch('/api/profile', { phone_number: '+260 977 123456' });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.phone_number).toBe('+260 977 123456');
  });

  test.each([
    ['role', 'admin'], ['status', 'active'], ['verification_status', 'verified'], ['created_by', 1],
    ['password_hash', '$argon2id$x'], ['full_name', 'Someone Else'], ['email', 'x@vault24.test'], ['balance_minor', 1000000],
  ])('customers cannot change %s through their profile', async (field, value) => {
    const user = w.addUser({ verification: 'pending' });
    const c = await w.login(user);
    const res = await c.patch('/api/profile', { [field]: value });
    expect(res.status).toBe(400);
    const row = w.db.prepare('SELECT role, verification_status, email FROM users WHERE id = ?').get(user.id);
    expect(row).toEqual({ role: 'customer', verification_status: 'pending', email: user.email });
  });
});

describe('Admin user management', () => {
  test('admin creates staff with a temporary password; customers and staff cannot', async () => {
    const admin = await w.login(w.admin);
    const res = await admin.post('/api/admin/staff', { full_name: 'Nancy Teller', email: 'nancy@vault24.test' });
    expect(res.status).toBe(201);
    expect(res.body.staff).toMatchObject({ role: 'staff', created_by: w.admin.id });
    expect(res.body.temporary_password).toBeDefined();
    expect((await staffClient.post('/api/admin/staff', { full_name: 'Sneaky Staff', email: 'sneaky@vault24.test' })).status).toBe(403);
  });

  test('admin cannot assign a role via the staff endpoint', async () => {
    const admin = await w.login(w.admin);
    expect((await admin.post('/api/admin/staff', { full_name: 'Role Try', email: 'roletry@vault24.test', role: 'admin' })).status).toBe(400);
  });

  test('admin can suspend a user (killing their sessions) and unlock a locked user', async () => {
    const admin = await w.login(w.admin);
    const user = w.addUser();
    const c = await w.login(user);
    const res = await admin.patch(`/api/admin/users/${user.id}/status`, { status: 'suspended', reason: 'Fraud review' });
    expect(res.status).toBe(200);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(sess, '$.userId') = ?").get(user.id).n).toBe(0);
    expect((await c.get('/api/profile')).status).toBe(401);

    w.db.prepare("UPDATE users SET status = 'locked', failed_login_attempts = 5 WHERE id = ?").run(user.id);
    await admin.patch(`/api/admin/users/${user.id}/status`, { status: 'active' });
    expect(w.db.prepare('SELECT status, failed_login_attempts FROM users WHERE id = ?').get(user.id)).toEqual({ status: 'active', failed_login_attempts: 0 });
  });

  test('admins cannot change their own status', async () => {
    const admin = await w.login(w.admin);
    expect((await admin.patch(`/api/admin/users/${w.admin.id}/status`, { status: 'suspended' })).status).toBe(403);
  });

  test('staff cannot change user status', async () => {
    expect((await staffClient.patch(`/api/admin/users/${w.admin.id}/status`, { status: 'suspended' })).status).toBe(403);
  });
});
