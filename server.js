const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3040;

// Setup multer for file uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// Separate multer for backup restore (uses /tmp)
const restoreStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, '/tmp'),
  filename: (req, file, cb) => cb(null, 'restore-' + Date.now() + '.zip')
});
const uploadRestore = multer({ storage: restoreStorage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB for restores

// Increase payload limit for large file uploads (base64 images)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// JSON body parsing
app.use(express.json());

// Debug middleware
app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

const dbPath = process.env.DB_PATH || 'cabledrums.db';
const db = new Database(dbPath);
console.log('Database opened');

// Create tables one by one
const tables = [
  `CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS drum_owners (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS cable_types (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS cable_counts (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sheath_colours (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS manufacturers (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS warehouses (id INTEGER PRIMARY KEY, name TEXT UNIQUE, archived INTEGER DEFAULT 0)`,,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT)`,
  `CREATE TABLE IF NOT EXISTS cable_drums (
    id INTEGER PRIMARY KEY, drum_number TEXT, client TEXT, drum_owner TEXT, cable_type TEXT,
    cable_count TEXT, sheath_colour TEXT, type TEXT, inner_end_reading REAL, outer_end_reading REAL,
    opening_entry_length REAL, remaining_length REAL, price_per_meter REAL, value_on_hand REAL, audit_date DATE, audit_by TEXT,
    status TEXT DEFAULT 'Active', sign_status TEXT DEFAULT 'Signed In', sign_out_to TEXT, sign_out_date DATE, sign_in_date DATE,
    project_allocation TEXT, project_drum_number TEXT, batch_number TEXT, manufacturer TEXT,
    manufacture_date DATE, status_reason TEXT, comments TEXT, created_by TEXT,
    drum_photo TEXT, warehouse TEXT, warehouse_location TEXT,
    created_on DATETIME DEFAULT CURRENT_TIMESTAMP, updated_on DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS cable_allocations (
    id INTEGER PRIMARY KEY, drum_id INTEGER, project_allocation TEXT, qty_used REAL,
    qty_remaining REAL, used_by TEXT, comments TEXT, kp_from REAL, kp_to REAL, created_on DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS user_client_access (id INTEGER PRIMARY KEY, user_id INTEGER, client_name TEXT)`,
  `CREATE TABLE IF NOT EXISTS user_owner_access (id INTEGER PRIMARY KEY, user_id INTEGER, drum_owner_name TEXT)`
];

tables.forEach(sql => {
  try {
    db.exec(sql);
    console.log('Created table');
  } catch(e) {
    console.error('Error creating table:', e.message);
  }
});

// Add user columns if they don't exist
try { db.exec('ALTER TABLE users ADD COLUMN created_on DATETIME DEFAULT CURRENT_TIMESTAMP'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN first_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN last_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1'); } catch(e) {}

console.log('Tables created');

// Migration: add archived column to lookup tables if missing
['clients', 'drum_owners', 'cable_types', 'cable_counts', 'categories', 'sheath_colours', 'manufacturers', 'projects', 'warehouses'].forEach(table => {
  try { db.prepare('SELECT archived FROM ' + table + ' LIMIT 1').get(); } catch(e) {
    if (e.message.includes('no such column')) {
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN archived INTEGER DEFAULT 0');
      console.log('Added archived column to ' + table);
    }
  }
});

// Migration: add qty_remaining column if missing
try {
  db.prepare('SELECT qty_remaining FROM cable_allocations LIMIT 1').get();
} catch(e) {
  if (e.message.includes('no such column')) {
    db.exec('ALTER TABLE cable_allocations ADD COLUMN qty_remaining REAL');
    console.log('Added qty_remaining column to cable_allocations');
  }
}

// Migration: add permissions column to users
try {
  db.prepare('SELECT permissions FROM users LIMIT 1').get();
} catch(e) {
  if (e.message.includes('no such column')) {
    db.exec('ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT "{}"');
    console.log('Added permissions column to users');
  }
}

// Migration: add must_change_password column
try {
  db.prepare('SELECT must_change_password FROM users LIMIT 1').get();
} catch(e) {
  if (e.message.includes('no such column')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 1');
    // Set existing users to 0 (they've already been using the system)
    db.exec('UPDATE users SET must_change_password = 0');
    console.log('Added must_change_password column to users');
  }
}

const ROLES = {
  admin: { canCreate: true, canEdit: true, canDelete: true, canAddAllocation: true, canManageUsers: true, canView: true },
  office: { canCreate: true, canEdit: true, canDelete: false, canAddAllocation: true, canManageUsers: false, canView: true },
  user: { canCreate: false, canEdit: false, canDelete: false, canAddAllocation: true, canManageUsers: false, canView: true },
  client: { canCreate: false, canEdit: false, canDelete: false, canAddAllocation: false, canManageUsers: false, canView: true }
};

// Get user's full name, fallback to username
function getUserFullName(username) {
  try {
    const u = db.prepare('SELECT first_name, last_name FROM users WHERE username = ?').get(username);
    const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ');
    return name || username;
  } catch(e) { return username; }
}

// Get effective permissions for a user (base role + overrides)
function getEffectivePermissions(user) {
  const base = { ...ROLES[user.role] || ROLES.client };
  try {
    const dbUser = db.prepare('SELECT permissions FROM users WHERE username = ?').get(user.username);
    if (dbUser && dbUser.permissions) {
      const overrides = JSON.parse(dbUser.permissions);
      Object.assign(base, overrides);
    }
  } catch(e) {}
  return base;
}

const requireRole = (roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// Add default admin (only if no users exist)
try {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (userCount.c === 0) {
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', 'admin123', 'admin');
    console.log('Default admin user created');
  }
} catch(e) {
  console.error('User init error:', e.message);
}

const users = {};
const sessions = {};

// Load users from DB on startup
try {
  const dbUsers = db.prepare('SELECT username, password, role, id, active FROM users').all();
  dbUsers.forEach(u => { users[u.username] = { password: u.password, role: u.role, id: u.id }; });
  console.log('Users loaded:', Object.keys(users).length);
} catch(e) {
  console.error('Error loading users:', e.message);
}

app.use((req, res, next) => {
  const sid = req.headers.authorization;
  if (sid && sessions[sid]) req.user = sessions[sid];
  next();
});

// Auth
app.post('/api/login', (req, res) => {
  const username = (req.body || {}).username || '';
  const password = (req.body || {}).password || '';
  
  // Check database directly for active status
  const dbUser = db.prepare('SELECT id, username, password, role, active, first_name, last_name, permissions FROM users WHERE username = ?').get(username);
  
  if (dbUser && dbUser.password === password && dbUser.active !== 0) {
    const sid = Math.random().toString(36).slice(2);
    sessions[sid] = { username: dbUser.username, role: dbUser.role, id: dbUser.id };
    const perms = getEffectivePermissions({ username: dbUser.username, role: dbUser.role });
    res.json({ token: sid, user: { username: dbUser.username, role: dbUser.role, first_name: dbUser.first_name, last_name: dbUser.last_name, permissions: perms, must_change_password: !!dbUser.must_change_password } });
  } else { 
    console.log('Login failed for:', username);
    res.status(401).json({ error: 'Invalid credentials' }); 
  }
});

app.post('/api/logout', (req, res) => {
  const sid = req.headers.authorization;
  if (sid) delete sessions[sid];
  res.json({ success: true });
});

// Old /api/me removed - using new one with permissions above

const requireAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.get('/api/me', requireAuth, (req, res) => {
  const perms = getEffectivePermissions(req.user);
  const dbUser = db.prepare('SELECT id, username, role, first_name, last_name, email, must_change_password FROM users WHERE username = ?').get(req.user.username);
  res.json({ ...dbUser, must_change_password: !!dbUser.must_change_password, permissions: perms });
});

// Change own password
app.post('/api/change-password', requireAuth, (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE username = ?').run(newPassword, req.user.username);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// User management APIs
app.get('/api/users', requireAuth, (req, res) => {
  const perms = getEffectivePermissions(req.user);
  if (req.user.role !== 'admin' && !perms.canManageUsers) return res.status(403).json({ error: 'Forbidden' });
  try {
    let users;
    try {
      let sql = 'SELECT id, username, role, first_name, last_name, email, active, permissions, created_on FROM users WHERE 1=1';
      if (req.query.status === 'active') { sql += ' AND active = 1'; }
      else if (req.query.status === 'inactive') { sql += ' AND active = 0'; }
      sql += ' ORDER BY username';
      users = db.prepare(sql).all();
    } catch(e) {
      let sql = 'SELECT id, username, role FROM users';
      if (req.query.status === 'inactive') { sql += ' WHERE 1=0'; }
      sql += ' ORDER BY username';
      users = db.prepare(sql).all();
      users = users.map(u => ({ ...u, first_name: '', last_name: '', email: '', active: 1 }));
    }
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireAuth, (req, res) => {
  // Allow admin or users with canManageUsers permission
  const perms = getEffectivePermissions(req.user);
  if (req.user.role !== 'admin' && !perms.canManageUsers) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { username, password, role, first_name, last_name, email, active, permissions } = req.body || {};
    if (!username || !password || !role) return res.status(400).json({ error: 'Username, password and role required' });
    if (!ROLES[role]) return res.status(400).json({ error: 'Invalid role' });
    const permJson = permissions ? JSON.stringify(permissions) : '{}';
    const r = db.prepare('INSERT INTO users (username, password, role, first_name, last_name, email, active, permissions, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run(username, password, role, first_name || '', last_name || '', email || '', active !== undefined ? (active ? 1 : 0) : 1, permJson);
    users[username] = { password, role, id: r.lastInsertRowid };
    res.json({ id: r.lastInsertRowid, username, role });
  } catch(e) { res.status(400).json({ error: 'Username already exists or error' }); }
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const perms = getEffectivePermissions(req.user);
  if (req.user.role !== 'admin' && !perms.canManageUsers) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { username, password, role, first_name, last_name, email, active, permissions } = req.body || {};
    if (!username || !role || !ROLES[role]) return res.status(400).json({ error: 'Invalid data' });
    const permJson = permissions ? JSON.stringify(permissions) : '{}';
    if (password) {
      db.prepare('UPDATE users SET username = ?, password = ?, role = ?, first_name = ?, last_name = ?, email = ?, active = ?, permissions = ? WHERE id = ?').run(username, password, role, first_name || '', last_name || '', email || '', active !== undefined ? (active ? 1 : 0) : 1, permJson, req.params.id);
    } else {
      db.prepare('UPDATE users SET username = ?, role = ?, first_name = ?, last_name = ?, email = ?, active = ?, permissions = ? WHERE id = ?').run(username, role, first_name || '', last_name || '', email || '', active !== undefined ? (active ? 1 : 0) : 1, permJson, req.params.id);
    }
    users[username] = { password: password || users[username]?.password, role, id: parseInt(req.params.id) };
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    if (req.user.id == req.params.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// User access management (for client role)
app.get('/api/users/:id/access', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const clients = db.prepare('SELECT client_name FROM user_client_access WHERE user_id = ?').all(userId);
    const owners = db.prepare('SELECT drum_owner_name FROM user_owner_access WHERE user_id = ?').all(userId);
    res.json({
      clients: clients.map(c => c.client_name),
      owners: owners.map(o => o.drum_owner_name)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:id/access', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { clients, owners } = req.body || {};
    
    // Delete existing access
    db.prepare('DELETE FROM user_client_access WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_owner_access WHERE user_id = ?').run(userId);
    
    // Insert new client access
    if (clients && Array.isArray(clients)) {
      const insertClient = db.prepare('INSERT INTO user_client_access (user_id, client_name) VALUES (?, ?)');
      clients.forEach(client => {
        if (client) insertClient.run(userId, client);
      });
    }
    
    // Insert new owner access
    if (owners && Array.isArray(owners)) {
      const insertOwner = db.prepare('INSERT INTO user_owner_access (user_id, drum_owner_name) VALUES (?, ?)');
      owners.forEach(owner => {
        if (owner) insertOwner.run(userId, owner);
      });
    }
    
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lookup APIs
const lookupTables = ['clients', 'drum_owners', 'cable_types', 'cable_counts', 'categories', 'sheath_colours', 'projects', 'manufacturers', 'warehouses'];
lookupTables.forEach(table => {
  app.get('/api/' + table, requireAuth, (req, res) => {
    try {
      const filter = req.query.filter; // 'active', 'archived', or 'all'
      let sql = 'SELECT * FROM ' + table;
      if (filter === 'active') sql += ' WHERE archived = 0';
      else if (filter === 'archived') sql += ' WHERE archived = 1';
      sql += ' ORDER BY name';
      res.json(db.prepare(sql).all());
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.patch('/api/' + table + '/:id', requireAuth, requireRole(['admin', 'office']), (req, res) => {
    try {
      const { archived } = req.body;
      db.prepare('UPDATE ' + table + ' SET archived = ? WHERE id = ?').run(archived ? 1 : 0, req.params.id);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/' + table, requireAuth, (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name required' });
    try {
      const r = db.prepare('INSERT INTO ' + table + ' (name) VALUES (?)').run(name);
      res.json({ id: r.lastInsertRowid, name });
    } catch(e) { res.status(400).json({ error: 'Already exists or error' }); }
  });
  app.delete('/api/' + table + '/:id', requireAuth, (req, res) => {
    try {
      db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
});

// Drums API
app.get('/api/drums', requireAuth, (req, res) => {
  try {
    let sql = 'SELECT * FROM cable_drums WHERE 1=1';
    const params = [];

    // Filter by client role access
    if (req.user.role === 'client') {
      const userId = req.user.id;
      // Get allowed clients for this user
      const clientAccess = db.prepare('SELECT client_name FROM user_client_access WHERE user_id = ?').all(userId);
      const ownerAccess = db.prepare('SELECT drum_owner_name FROM user_owner_access WHERE user_id = ?').all(userId);
      const allowedClients = clientAccess.map(c => c.client_name);
      const allowedOwners = ownerAccess.map(o => o.drum_owner_name);

      if (allowedClients.length > 0 || allowedOwners.length > 0) {
        const conditions = [];
        if (allowedClients.length > 0) {
          conditions.push('client IN (' + allowedClients.map(() => '?').join(',') + ')');
          params.push(...allowedClients);
        }
        if (allowedOwners.length > 0) {
          conditions.push('drum_owner IN (' + allowedOwners.map(() => '?').join(',') + ')');
          params.push(...allowedOwners);
        }
        sql += ' AND (' + conditions.join(' OR ') + ')';
      } else {
        // Client user with no access - return empty
        res.json([]);
        return;
      }
    }

    const filters = ['client', 'drum_owner', 'cable_type', 'cable_count', 'sheath_colour', 'type', 'status', 'sign_status', 'warehouse', 'project_allocation'];
    filters.forEach(f => {
      if (req.query[f]) { sql += ' AND ' + f + ' = ?'; params.push(req.query[f]); }
    });
    if (req.query.search) {
      sql += ' AND (drum_number LIKE ? OR comments LIKE ? OR project_allocation LIKE ?)';
      const s = '%' + req.query.search + '%';
      params.push(s, s, s);
    }
    const sortCol = req.query.sort || 'drum_number';
    const sortOrder = req.query.order || 'ASC';
    const allowedSorts = ['drum_number', 'client', 'drum_owner', 'remaining_length', 'cable_type', 'cable_count', 'type', 'status', 'updated_on'];
    const sortKey = allowedSorts.includes(sortCol) ? sortCol : 'drum_number';
    const sortDir = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    sql += ' ORDER BY ' + sortKey + ' ' + sortDir;
    const drums = db.prepare(sql).all(...params);
    res.json(drums);
  } catch(e) { 
    console.error('Get drums error:', e.message); 
    res.json([]); 
  }
});

// Export drums as CSV
app.get('/api/drums/export', requireAuth, (req, res) => {
  try {
    // Apply same filters as the drums list
    let sql = 'SELECT * FROM cable_drums WHERE 1=1';
    const filterParams = [];
    const filters = ['client', 'drum_owner', 'cable_type', 'cable_count', 'sheath_colour', 'type', 'status', 'sign_status', 'warehouse', 'project_allocation'];
    filters.forEach(f => {
      if (req.query[f]) { sql += ' AND ' + f + ' = ?'; filterParams.push(req.query[f]); }
    });
    if (req.query.search) {
      sql += ' AND (drum_number LIKE ? OR comments LIKE ? OR project_allocation LIKE ?)';
      const s = '%' + req.query.search + '%';
      filterParams.push(s, s, s);
    }
    sql += ' ORDER BY drum_number';
    const drums = db.prepare(sql).all(...filterParams);
    
    const headers = ['drum_number', 'client', 'drum_owner', 'cable_type', 'cable_count', 'sheath_colour', 'type', 'inner_end_reading', 'outer_end_reading', 'opening_entry_length', 'remaining_length', 'price_per_meter', 'value_on_hand', 'audit_date', 'audit_by', 'status', 'sign_status', 'sign_out_to', 'sign_out_date', 'sign_in_date', 'project_allocation', 'project_drum_number', 'batch_number', 'manufacturer', 'manufacture_date', 'status_reason', 'comments', 'warehouse', 'warehouse_location', 'created_on', 'updated_on'];
    const csvRows = [headers.join(',')];
    
    for (const drum of drums) {
      const row = headers.map(h => {
        let val = drum[h] || '';
        // Always wrap in quotes to be safe - handles commas, newlines, quotes
        if (typeof val === 'string') {
          val = '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      });
      csvRows.push(row.join(','));
    }
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=drums_export.csv');
    res.send(csvRows.join('\n'));
  } catch(e) {
    console.error('Export error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const ensureLookupValue = (table, value) => {
  if (!value) return null;
  const cleanValue = String(value).trim();
  if (!cleanValue) return null;
  try {
    const exists = db.prepare('SELECT id FROM ' + table + ' WHERE name = ?').get(cleanValue);
    if (exists) return cleanValue;
    db.prepare('INSERT INTO ' + table + ' (name) VALUES (?)').run(cleanValue);
    return cleanValue;
  } catch(e) {
    return cleanValue;
  }
};


// CSV parser that handles quoted fields with commas
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// Bulk import preview endpoint
app.post('/api/drums/import-preview', requireRole(['admin']), (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv) return res.status(400).json({ error: 'No CSV data provided' });
    
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header and at least one data row' });
    
    const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    const preview = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
      
      const drumNumber = row.drum_number;
      const existing = db.prepare('SELECT id FROM cable_drums WHERE drum_number = ?').get(drumNumber);
      
      preview.push({
        row: i + 1,
        drum_number: drumNumber,
        isDuplicate: !!existing,
        action: existing ? 'skip' : 'add',
        client: row.client || '',
        cable_type: row.cable_type || ''
      });
    }
    
    res.json({ preview });
  } catch(e) {
    console.error('Preview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk import endpoint
app.post('/api/drums/import', requireRole(['admin']), (req, res) => {
  try {
    const { csv, rowActions } = req.body;
    if (!csv) return res.status(400).json({ error: 'No CSV data provided' });
    
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header and at least one data row' });
    
    const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    const results = { imported: 0, duplicates: [], errors: [] };
    
    for (let i = 1; i < lines.length; i++) {
      try {
        const values = parseCsvLine(lines[i]);
        const row = {};
        headers.forEach((h, idx) => {
          const v = values[idx];
          row[h] = typeof v === 'string' ? v.trim() : (v || '');
        });
        
        let drumNumber = row.drum_number;
        const existing = db.prepare('SELECT id FROM cable_drums WHERE drum_number = ?').get(drumNumber);
        const action = rowActions && rowActions[i + 1] ? rowActions[i + 1] : (existing ? 'skip' : 'add');
        
        if (action === 'skip') {
          results.duplicates.push({ row: i + 1, drum_number: drumNumber });
          continue;
        } else if (action === 'addnew' && existing) {
          drumNumber = drumNumber + ' New';
        }
        
        const client = ensureLookupValue('clients', row.client);
        const drumOwner = ensureLookupValue('drum_owners', row.drum_owner);
        const cableType = ensureLookupValue('cable_types', row.cable_type);
        const cableCount = ensureLookupValue('cable_counts', row.cable_count);
        const sheathColour = ensureLookupValue('sheath_colours', row.sheath_colour);
        const warehouse = ensureLookupValue('warehouses', row.warehouse);
        const project = ensureLookupValue('projects', row.project_allocation || row.project);
        const category = ensureLookupValue('categories', row.type);
        const manufacturer = ensureLookupValue('manufacturers', row.manufacturer);
        
        const inner = row.inner_end_reading !== '' ? parseFloat(row.inner_end_reading) : null;
        const outer = row.outer_end_reading !== '' ? parseFloat(row.outer_end_reading) : null;
        const calculated = (inner !== null && outer !== null) ? Math.abs(outer - inner) : null;
        const openingLength = row.opening_entry_length !== '' ? parseFloat(row.opening_entry_length) : calculated;
        // Use calculated from inner/outer, or fall back to opening_entry_length
        const remainingLength = calculated !== null ? calculated : openingLength;
        
        // Calculate value_on_hand if not provided: price_per_meter * remaining_length
        let pricePerMeter = row.price_per_meter !== '' ? parseFloat(row.price_per_meter) : null;
        let valueOnHand = row.value_on_hand !== '' ? parseFloat(row.value_on_hand) : null;
        if (valueOnHand === null && pricePerMeter !== null && remainingLength !== null) {
          valueOnHand = pricePerMeter * remainingLength;
        }
        
        // Normalize manufacture_date (handle various formats)
        let manufactureDate = row.manufacture_date || row.manufacture_date_ || row.manufactured || '';
        
        db.prepare(`INSERT INTO cable_drums (
          drum_number, client, drum_owner, cable_type, cable_count, sheath_colour, type,
          inner_end_reading, outer_end_reading, opening_entry_length, remaining_length,
          price_per_meter, value_on_hand, audit_date, audit_by, status, sign_status,
          sign_out_to, sign_out_date, sign_in_date, project_allocation, project_drum_number,
          batch_number, manufacturer, manufacture_date, status_reason, comments,
          warehouse, warehouse_location, created_on
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(
          row.drum_number, client, drumOwner, cableType, cableCount, sheathColour, category,
          inner, outer, openingLength, remainingLength,
          pricePerMeter, valueOnHand,
          row.audit_date, row.audit_by, row.status || 'Active', row.sign_status || 'Signed In',
          row.sign_out_to, row.sign_out_date, row.sign_in_date, project, row.project_drum_number,
          row.batch_number, manufacturer, manufactureDate, row.status_reason, row.comments,
          warehouse, row.warehouse_location
        );

        // Create opening allocation for the imported drum
        const insertedId = db.prepare('SELECT id FROM cable_drums WHERE drum_number = ? ORDER BY id DESC LIMIT 1').get(row.drum_number);
        if (insertedId) {
          db.prepare('INSERT INTO cable_allocations (drum_id, project_allocation, qty_used, qty_remaining, used_by, comments, created_on) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(
            insertedId.id, project || null, 0, openingLength, 'Import', 'Opening Entry'
          );
        }

        results.imported++;
      } catch(rowErr) {
        results.errors.push({ row: i + 1, error: rowErr.message });
      }
    }
    
    res.json(results);
  } catch(e) {
    console.error('Import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Database backup - download the entire SQLite file
app.get('/api/backup', requireRole(['admin']), (req, res) => {
  try {
    const fs = require('fs');
    const dbFile = dbPath;
    if (!fs.existsSync(dbFile)) return res.status(404).json({ error: 'Database file not found' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Disposition', 'attachment; filename=cabledrums-backup-' + timestamp + '.db');
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(dbFile);
    stream.pipe(res);
  } catch(e) {
    console.error('Backup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Database restore - upload a SQLite file to replace the database
app.post('/api/restore', requireRole(['admin']), (req, res) => {
  try {
    const fs = require('fs');
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'No database data provided' });
    // data is base64 encoded
    const buffer = Buffer.from(data, 'base64');
    // Verify it's a SQLite file
    if (buffer.length < 16 || buffer.toString('utf8', 0, 15) !== 'SQLite format 3') {
      return res.status(400).json({ error: 'Invalid SQLite file' });
    }
    // Close current db, write new file, reopen
    db.close();
    fs.writeFileSync(dbPath, buffer);
    // Reopen - need to reassign but can't reassign const, so restart is needed
    res.json({ success: true, message: 'Database restored. The server will restart to apply changes.' });
    // Exit so the container restarts
    setTimeout(() => process.exit(0), 1000);
  } catch(e) {
    console.error('Restore error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Full backup - database + uploads as a zip file
app.get('/api/backup-full', requireRole(['admin']), (req, res) => {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    
    // Add database file
    if (fs.existsSync(dbPath)) {
      zip.addLocalFile(dbPath, '', 'cabledrums.db');
    }
    
    // Add uploads folder
    if (fs.existsSync(uploadsDir)) {
      const uploadFiles = fs.readdirSync(uploadsDir);
      uploadFiles.forEach(f => {
        zip.addLocalFile(path.join(uploadsDir, f), 'uploads');
      });
    }
    
    const zipBuffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=backup-' + new Date().toISOString().split('T')[0] + '.zip');
    res.send(zipBuffer);
  } catch(e) {
    console.error('Full backup error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Full restore - upload a zip file with database + uploads
app.post('/api/restore-full', requireRole(['admin']), uploadRestore.single('backup'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No backup file uploaded' });
    }
    
    const tempZip = req.file.path;
    const extractDir = '/tmp/restore-' + Date.now();
    fs.mkdirSync(extractDir, { recursive: true });
    
    // Extract zip
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(tempZip);
    zip.extractAllTo(extractDir, true);
    
    // Restore database
    const extractedDb = path.join(extractDir, 'cabledrums.db');
    if (fs.existsSync(extractedDb)) {
      db.close();
      fs.copyFileSync(extractedDb, dbPath);
    }
    
    // Restore uploads
    const extractedUploads = path.join(extractDir, 'uploads');
    if (fs.existsSync(extractedUploads)) {
      // Clear existing uploads and copy new ones
      if (fs.existsSync(uploadsDir)) {
        fs.readdirSync(uploadsDir).forEach(f => fs.unlinkSync(path.join(uploadsDir, f)));
      }
      fs.readdirSync(extractedUploads).forEach(f => {
        fs.copyFileSync(path.join(extractedUploads, f), path.join(uploadsDir, f));
      });
    }
    
    // Cleanup
    fs.unlinkSync(tempZip);
    fs.rmSync(extractDir, { recursive: true, force: true });
    
    res.json({ success: true, message: 'Full backup restored. The server will restart to apply changes.' });
    setTimeout(() => process.exit(0), 1000);
  } catch(e) {
    console.error('Full restore error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Allocation import endpoint
app.post('/api/allocations/import', requireRole(['admin']), (req, res) => {
  try {
    const { csv, skipOpeningEntries } = req.body;
    if (!csv) return res.status(400).json({ error: 'No CSV data provided' });
    
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header and at least one data row' });
    
    const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/ /g, '_'));
    const results = { imported: 0, skipped: 0, errors: [] };
    
    for (let i = 1; i < lines.length; i++) {
      try {
        const values = parseCsvLine(lines[i]);
        const row = {};
        headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });
        
        // Map column names
        const drumNumber = row.cable_drum || row.drum_number || '';
        const comments = row.comments || '';
        
        // Skip opening entries if requested
        if (skipOpeningEntries && comments.toLowerCase().includes('opening entry')) {
          results.skipped++;
          continue;
        }
        
        // Find drum by number
        const drum = db.prepare('SELECT id FROM cable_drums WHERE drum_number = ?').get(drumNumber);
        if (!drum) {
          results.errors.push('Row ' + (i+1) + ': Drum not found: ' + drumNumber);
          continue;
        }
        
        const project = row.project_allocation || null;
        const qtyUsed = row.qty_used ? parseFloat(row.qty_used) : 0;
        const usedBy = row.used_by || null;
        const kpFrom = row.kp_from ? parseFloat(row.kp_from) : null;
        const kpTo = row.kp_to ? parseFloat(row.kp_to) : null;
        const createdOn = row.created_on || new Date().toISOString();
        
        // Calculate qty_remaining: get the last allocation's qty_remaining and subtract this qty_used
        const lastAlloc = db.prepare('SELECT qty_remaining FROM cable_allocations WHERE drum_id = ? ORDER BY id DESC LIMIT 1').get(drum.id);
        // If no previous allocation, use opening_entry_length from the drum
        const drumData = db.prepare('SELECT opening_entry_length FROM cable_drums WHERE id = ?').get(drum.id);
        const prevRemaining = lastAlloc ? (lastAlloc.qty_remaining || 0) : (drumData ? (drumData.opening_entry_length || 0) : 0);
        const qtyRemaining = prevRemaining - qtyUsed;
        
        db.prepare('INSERT INTO cable_allocations (drum_id, project_allocation, qty_used, qty_remaining, used_by, comments, kp_from, kp_to, created_on) VALUES (?,?,?,?,?,?,?,?,?)').run(
          drum.id, project, qtyUsed, qtyRemaining, usedBy, comments, kpFrom, kpTo, createdOn
        );
        
        // Update drum's remaining_length
        db.prepare('UPDATE cable_drums SET remaining_length = ? WHERE id = ?').run(qtyRemaining, drum.id);
        
        results.imported++;
      } catch(e) {
        results.errors.push('Row ' + (i+1) + ': ' + e.message);
      }
    }
    
    res.json({ success: true, results });
  } catch(e) {
    console.error('Allocation import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Master delete - deletes all data except users
app.post('/api/master-delete', requireRole(['admin']), (req, res) => {
  try {
    const counts = {};
    // Delete in order: allocations first (references drums), then drums, then lookups
    const tables = [
      'cable_allocations',
      'cable_drums',
      'user_client_access',
      'user_owner_access',
      'clients',
      'drum_owners',
      'cable_types',
      'cable_counts',
      'categories',
      'sheath_colours',
      'manufacturers',
      'projects',
      'warehouses'
    ];
    tables.forEach(t => {
      try {
        const info = db.prepare('SELECT COUNT(*) as c FROM ' + t).get();
        const count = info ? info.c : 0;
        db.prepare('DELETE FROM ' + t).run();
        counts[t] = count;
        console.log('Deleted ' + count + ' rows from ' + t);
      } catch(e) {
        console.error('Error deleting ' + t + ':', e.message);
        counts[t] = 'error: ' + e.message;
      }
    });
    console.log('Master delete complete:', counts);
    res.json({ success: true, deleted: counts });
  } catch(e) {
    console.error('Master delete error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Upload drum photo endpoint
app.post('/api/drums/photo', requireAuth, (req, res) => {
  try {
    upload.single('photo')(req, res, (err) => {
      if (err) {
        console.error('Upload error:', err.message);
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      // Return the filename so frontend can associate with drum
      res.json({ filename: req.file.filename, originalName: req.file.originalname });
    });
  } catch(e) {
    console.error('Photo upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete drum photo endpoint
app.delete('/api/drums/photo/:filename', requireAuth, (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.json({ success: true, message: 'File not found' });
    }
  } catch(e) {
    console.error('Photo delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/drums', requireAuth, (req, res) => {
  const perms = getEffectivePermissions(req.user);
  console.log('Create drum - user:', req.user.username, 'role:', req.user.role, 'perms:', JSON.stringify(perms));
  if (!perms.canCreate) return res.status(403).json({ error: 'Permission denied' });
  try {
    const d = req.body || {};
    console.log('Saving drum:', d);
    const inner = parseFloat(d.inner_end_reading) || 0;
    const outer = parseFloat(d.outer_end_reading) || 0;
    const openingLength = Math.abs(outer - inner);
    const remainingLength = Math.abs(outer - inner);
    
    // Get current time in Melbourne timezone
    const now = new Date();
    const melbourneTime = now.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/(\d{2})\/(\d{2})\/(\d{4}), (.*)/, '$3-$2-$1 $4');

    const stmt = db.prepare(`
      INSERT INTO cable_drums (drum_number, client, drum_owner, cable_type, cable_count, sheath_colour, type,
        inner_end_reading, outer_end_reading, opening_entry_length, remaining_length, price_per_meter, value_on_hand,
        audit_date, audit_by, status, sign_status, sign_out_to, sign_out_date, sign_in_date,
        project_allocation, project_drum_number, batch_number, manufacturer, manufacture_date,
        status_reason, comments, created_by, drum_photo, warehouse, warehouse_location, created_on)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const r = stmt.run(
      d.drum_number, d.client, d.drum_owner, d.cable_type, d.cable_count, d.sheath_colour, d.type,
      d.inner_end_reading, d.outer_end_reading, openingLength, remainingLength, d.price_per_meter, d.value_on_hand,
      d.audit_date, d.audit_by, d.status || 'Active', d.sign_status || 'Signed In', d.sign_out_to, d.sign_out_date, d.sign_in_date,
      d.project_allocation, d.project_drum_number, d.batch_number, d.manufacturer, d.manufacture_date,
      d.status_reason, d.comments, req.user.username, d.drum_photo || null, d.warehouse || null, d.warehouse_location || null, melbourneTime);

    if (openingLength > 0) {
      db.prepare('INSERT INTO cable_allocations (drum_id, project_allocation, qty_used, qty_remaining, used_by, comments, created_on) VALUES (?,?,?,?,?,?,?)').run(
        r.lastInsertRowid, d.project_allocation || null, 0, openingLength, req.user.username, 'Opening Entry', melbourneTime);
    }

    res.json({ id: r.lastInsertRowid });
  } catch(e) { console.error('Create drum error:', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/drums/:id', requireAuth, (req, res) => {
  if (!getEffectivePermissions(req.user).canEdit) return res.status(403).json({ error: 'Permission denied' });
  try {
    const d = req.body || {};
    const inner = parseFloat(d.inner_end_reading) || 0;
    const outer = parseFloat(d.outer_end_reading) || 0;
    const remainingLength = Math.abs(outer - inner);
    
    // Get current drum to compare remaining length
    const currentDrum = db.prepare('SELECT remaining_length FROM cable_drums WHERE id = ?').get(req.params.id);
    const oldRemaining = parseFloat(currentDrum?.remaining_length) || 0;
    const newRemaining = remainingLength;
    
    const stmt = db.prepare(`
      UPDATE cable_drums SET drum_number=?, client=?, drum_owner=?, cable_type=?, cable_count=?, sheath_colour=?, type=?, 
        inner_end_reading=?, outer_end_reading=?, remaining_length=?, price_per_meter=?, value_on_hand=?,
        audit_date=?, audit_by=?, status=?, sign_status=?, sign_out_to=?, sign_out_date=?, sign_in_date=?,
        project_allocation=?, project_drum_number=?, batch_number=?, manufacturer=?, manufacture_date=?,
        status_reason=?, comments=?, drum_photo=?, warehouse=?, warehouse_location=?, updated_on=CURRENT_TIMESTAMP WHERE id=?`);
    stmt.run(
      d.drum_number, d.client, d.drum_owner, d.cable_type, d.cable_count, d.sheath_colour, d.type,
      d.inner_end_reading, d.outer_end_reading, remainingLength, d.price_per_meter, d.value_on_hand,
      d.audit_date, d.audit_by, d.status, d.sign_status, d.sign_out_to, d.sign_out_date, d.sign_in_date,
      d.project_allocation, d.project_drum_number, d.batch_number, d.manufacturer, d.manufacture_date,
      d.status_reason, d.comments, d.drum_photo || null, d.warehouse || null, d.warehouse_location || null, req.params.id);
    
    // Auto-create allocation if remaining length changed - show new remaining, not qty used
    if (newRemaining !== oldRemaining) {
      // Get current time in Melbourne timezone
      const now = new Date();
      const melbourneTime = now.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/(\d{2})\/(\d{2})\/(\d{4}), (.*)/, '$3-$2-$1 $4');
      db.prepare('INSERT INTO cable_allocations (drum_id, project_allocation, qty_used, qty_remaining, used_by, comments, created_on) VALUES (?,?,?,?,?,?,?)').run(
        req.params.id, null, null, newRemaining, getUserFullName(req.user.username), 'Adjusted (Audit)', melbourneTime);
    }
    
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/drums/:id', requireAuth, (req, res) => {
  if (!getEffectivePermissions(req.user).canDelete) return res.status(403).json({ error: 'Permission denied' });
  try {
    // Delete allocations first, then the drum
    db.prepare('DELETE FROM cable_allocations WHERE drum_id=?').run(req.params.id);
    db.prepare('DELETE FROM cable_drums WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cable Allocations
app.get('/api/drums/:id/allocations', requireAuth, (req, res) => {
  try {
    const allocations = db.prepare('SELECT * FROM cable_allocations WHERE drum_id = ? ORDER BY id ASC').all(req.params.id);
    res.json(allocations);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get ALL allocations across all drums
app.get('/api/allocations', requireAuth, (req, res) => {
  try {
    const projectId = req.query.project_id;
    const projectName = req.query.project_name;
    const cf = getClientFilter(req.user);
    let query = 'SELECT ca.*, cd.drum_number, cd.client, cd.cable_type, cd.cable_count, cd.sheath_colour, cd.comments as drum_comments FROM cable_allocations ca LEFT JOIN cable_drums cd ON ca.drum_id = cd.id WHERE 1=1';
    const params = [];
    
    if (projectId) {
      query += ' AND ca.project_allocation = (SELECT name FROM projects WHERE id = ?)';
      params.push(projectId);
    } else if (projectName) {
      query += ' AND ca.project_allocation = ?';
      params.push(projectName);
    }
    // Apply client access filter on the drum
    if (req.user.role === 'client') {
      const userId = db.prepare('SELECT id FROM users WHERE username = ?').get(req.user.username);
      if (userId) {
        const clientAccess = db.prepare('SELECT client_name FROM user_client_access WHERE user_id = ?').all(userId.id);
        const ownerAccess = db.prepare('SELECT drum_owner_name FROM user_owner_access WHERE user_id = ?').all(userId.id);
        const conditions = [];
        if (clientAccess.length > 0) {
          conditions.push('cd.client IN (' + clientAccess.map(() => '?').join(',') + ')');
          params.push(...clientAccess.map(c => c.client_name));
        }
        if (ownerAccess.length > 0) {
          conditions.push('cd.drum_owner IN (' + ownerAccess.map(() => '?').join(',') + ')');
          params.push(...ownerAccess.map(o => o.drum_owner_name));
        }
        if (conditions.length > 0) {
          query += ' AND (' + conditions.join(' OR ') + ')';
        } else {
          query += ' AND 1=0';
        }
      }
    }
    
    const allocations = db.prepare(query + ' ORDER BY ca.created_on DESC').all(...params);
    res.json(allocations);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Export allocations as CSV
app.get('/api/allocations/export', requireAuth, (req, res) => {
  try {
    const drumId = req.query.drum_id;
    const projectId = req.query.project_id;
    let query = 'SELECT cd.drum_number, cd.client, cd.cable_type, cd.cable_count, ca.project_allocation, ca.qty_used, ca.qty_remaining, ca.used_by, ca.comments, ca.kp_from, ca.kp_to, ca.created_on FROM cable_allocations ca LEFT JOIN cable_drums cd ON ca.drum_id = cd.id';
    const params = [];
    
    if (projectId) {
      query += ' WHERE ca.project_allocation = (SELECT name FROM projects WHERE id = ?)';
      params.push(projectId);
    } else if (drumId) {
      query += ' WHERE ca.drum_id = ?';
      params.push(drumId);
    }
    query += ' ORDER BY ca.created_on DESC';
    
    const allocations = db.prepare(query).all(...params);
    
    const headers = ['drum_number', 'client', 'cable_type', 'cable_count', 'project_allocation', 'qty_used', 'qty_remaining', 'used_by', 'comments', 'kp_from', 'kp_to', 'created_on'];
    const csvRows = [headers.join(',')];
    
    for (const alloc of allocations) {
      const row = headers.map(h => {
        let val = alloc[h] || '';
        if (typeof val === 'string') {
          val = '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      });
      csvRows.push(row.join(','));
    }
    
    let filename = 'allocations_export.csv';
    if (projectId) {
      const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
      filename = proj ? `project_${proj.name.replace(/\s+/g, '_')}_allocations.csv` : 'project_allocations.csv';
    } else if (drumId) {
      filename = `drum_${drumId}_allocations.csv`;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csvRows.join('\n'));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update only drum readings (used by allocation form)
app.patch('/api/drums/:id/readings', requireAuth, (req, res) => {
  try {
    const { inner_end_reading, outer_end_reading, remaining_length } = req.body;
    db.prepare('UPDATE cable_drums SET inner_end_reading=?, outer_end_reading=?, remaining_length=?, updated_on=CURRENT_TIMESTAMP WHERE id=?')
      .run(inner_end_reading, outer_end_reading, remaining_length, req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drums/:id/toggle-sign', requireAuth, (req, res) => {
  try {
    const drum = db.prepare('SELECT sign_status, remaining_length FROM cable_drums WHERE id = ?').get(req.params.id);
    if (!drum) return res.status(404).json({ error: 'Drum not found' });
    
    const now = new Date();
    const melbourneTime = now.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/(\d{2})\/(\d{2})\/(\d{4}), (.*)/, '$3-$2-$1 $4');
    
    let newStatus, allocComment, action;
    if (drum.sign_status === 'Signed In' || !drum.sign_status) {
      newStatus = 'Signed Out';
      allocComment = 'Signed Out';
      action = 'sign_out';
    } else {
      newStatus = 'Signed In';
      allocComment = 'Signed In';
      action = 'sign_in';
    }
    
    // Update drum status
    db.prepare('UPDATE cable_drums SET sign_status = ?, updated_on = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
    
    // Add allocation entry only for sign out
    if (action === 'sign_out') {
      db.prepare('INSERT INTO cable_allocations (drum_id, qty_used, qty_remaining, used_by, comments, created_on) VALUES (?,?,?,?,?,?)').run(
        req.params.id, 0, drum.remaining_length || 0, req.user.username, allocComment, melbourneTime);
    }
    
    res.json({ success: true, newStatus: newStatus, action: action });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drums/:id/allocations', requireAuth, (req, res) => {
  if (!getEffectivePermissions(req.user).canAddAllocation) return res.status(403).json({ error: 'Permission denied' });
  try {
    const { project_allocation, qty_used, qty_remaining, used_by, comments, kp_from, kp_to } = req.body;
    const now = new Date();
    const melbourneTime = now.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/(\d{2})\/(\d{2})\/(\d{4}), (.*)/, '$3-$2-$1 $4');
    const stmt = db.prepare('INSERT INTO cable_allocations (drum_id, project_allocation, qty_used, qty_remaining, used_by, comments, kp_from, kp_to, created_on) VALUES (?,?,?,?,?,?,?,?,?)');
    const r = stmt.run(req.params.id, project_allocation, qty_used, qty_remaining, used_by || getUserFullName(req.user.username), comments, kp_from, kp_to, melbourneTime);
    res.json({ id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Helper: get client access filter SQL for client role users
function getClientFilter(user) {
  if (user.role !== 'client') return { sql: '', params: [] };
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get(user.username);
  if (!userId) return { sql: ' AND 1=0', params: [] };
  const clientAccess = db.prepare('SELECT client_name FROM user_client_access WHERE user_id = ?').all(userId.id);
  const ownerAccess = db.prepare('SELECT drum_owner_name FROM user_owner_access WHERE user_id = ?').all(userId.id);
  const allowedClients = clientAccess.map(c => c.client_name);
  const allowedOwners = ownerAccess.map(o => o.drum_owner_name);
  if (allowedClients.length === 0 && allowedOwners.length === 0) return { sql: ' AND 1=0', params: [] };
  const conditions = [];
  const params = [];
  if (allowedClients.length > 0) {
    conditions.push('client IN (' + allowedClients.map(() => '?').join(',') + ')');
    params.push(...allowedClients);
  }
  if (allowedOwners.length > 0) {
    conditions.push('drum_owner IN (' + allowedOwners.map(() => '?').join(',') + ')');
    params.push(...allowedOwners);
  }
  return { sql: ' AND (' + conditions.join(' OR ') + ')', params };
}

app.get('/api/stats', requireAuth, (req, res) => {
  console.log('Stats requested by user:', req.user?.username);
  try {
    const cf = getClientFilter(req.user);
    const total = db.prepare('SELECT COUNT(*) as c FROM cable_drums WHERE 1=1' + cf.sql).get(...cf.params).c || 0;
    const signed = db.prepare("SELECT COUNT(*) as c FROM cable_drums WHERE sign_status='Signed Out'" + cf.sql).get(...cf.params).c || 0;
    const active = db.prepare("SELECT COUNT(*) as c FROM cable_drums WHERE status='Active'" + cf.sql).get(...cf.params).c || 0;
    const valueResult = db.prepare('SELECT SUM(remaining_length * price_per_meter) as v FROM cable_drums WHERE remaining_length IS NOT NULL AND price_per_meter IS NOT NULL' + cf.sql).get(...cf.params);
    const totalValue = valueResult?.v || 0;
    const warehouses = db.prepare("SELECT COUNT(DISTINCT warehouse) as c FROM cable_drums WHERE warehouse IS NOT NULL AND warehouse != ''" + cf.sql).get(...cf.params).c || 0;
    console.log('Stats result:', { total, signed, active, totalValue, warehouses });
    res.json({ total, signed, active, totalValue, warehouses });
  } catch(e) { 
    console.error('Stats error:', e);
    res.status(500).json({ error: e.message }); 
  }
});

// Client-scoped filter options - returns only values from accessible drums
app.get('/api/filter-options', requireAuth, (req, res) => {
  try {
    const cf = getClientFilter(req.user);
    const fields = ['client', 'drum_owner', 'cable_type', 'cable_count', 'type', 'warehouse', 'project_allocation'];
    const options = {};
    fields.forEach(f => {
      const rows = db.prepare('SELECT DISTINCT ' + f + ' as name FROM cable_drums WHERE ' + f + ' IS NOT NULL AND ' + f + " != '' AND 1=1" + cf.sql + ' ORDER BY ' + f).all(...cf.params);
      options[f] = rows.map(r => r.name);
    });
    res.json(options);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log('Cable Drum Register: http://localhost:' + PORT));