const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let mainWindow;
let db;
let backupTimer;
let quitting = false;

/* ---------------- تسجيل الأخطاء بملف (لتشخيص أي مشكلة لاحقاً) ---------------- */
function logError(context, err) {
  try {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${context}: ${err && err.stack ? err.stack : err}\n`;
    fs.appendFileSync(path.join(dir, 'error-log.txt'), line);
  } catch (e) { /* لا شيء يمكن فعله إذا فشل حتى تسجيل الخطأ */ }
}
process.on('uncaughtException', (err) => logError('uncaughtException', err));
process.on('unhandledRejection', (err) => logError('unhandledRejection', err));

/* ---------------- مسارات قاعدة البيانات والنسخ الاحتياطية ---------------- */
function getDbPath() {
  return path.join(app.getPath('userData'), 'pos-data.db');
}
function getBackupsDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------- تهيئة قاعدة بيانات SQLite ---------------- */
function initDatabase() {
  db = new Database(getDbPath());
  db.pragma('journal_mode = WAL'); // أداء أفضل وحماية أقوى من تلف الملف عند الإغلاق المفاجئ
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage (
      key        TEXT NOT NULL,
      shared     INTEGER NOT NULL DEFAULT 0,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (key, shared)
    );

    /* فواتير البيع: جدول حقيقي (صف لكل فاتورة) بدل تخزينها كنص JSON واحد ضخم.
       هذا يجعل إضافة فاتورة عملية سريعة وثابتة السرعة (INSERT صف واحد) بغض النظر
       عن عدد الفواتير السابقة، ويحل مشكلة البطء التراكمي مع الوقت. */
    CREATE TABLE IF NOT EXISTS invoices (
      id          TEXT PRIMARY KEY,
      number      INTEGER,
      date        TEXT NOT NULL,
      cashier     TEXT,
      customer    TEXT,
      customer_id TEXT,
      method      TEXT,
      subtotal    REAL,
      discount    REAL,
      tax         REAL,
      final       REAL,
      received    REAL,
      change      REAL,
      note        TEXT,
      returned    INTEGER NOT NULL DEFAULT 0,
      returned_at INTEGER,
      returned_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(date);

    CREATE TABLE IF NOT EXISTS invoice_lines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id   TEXT NOT NULL,
      product_id   TEXT,
      name         TEXT,
      qty          REAL,
      unit_price   REAL,
      addons_total REAL,
      addons_names TEXT,
      note         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

    /* فواتير الشراء من الموردين: نفس المبدأ */
    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id            TEXT PRIMARY KEY,
      date          TEXT NOT NULL,
      supplier_id   TEXT,
      supplier      TEXT,
      payment_type  TEXT,
      total         REAL
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_invoices_date ON purchase_invoices(date);

    CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_invoice_id TEXT NOT NULL,
      product_id          TEXT,
      ing_id              TEXT,
      name                TEXT,
      qty                 REAL,
      cost                REAL,
      sell_price          REAL,
      total               REAL
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_lines_pinv ON purchase_invoice_lines(purchase_invoice_id);
  `);
}

/* ---------------- ترقية تلقائية للبيانات القديمة (مرة واحدة فقط) ----------------
   إذا كان البرنامج يحتوي بيانات قديمة مخزّنة كنص JSON واحد تحت المفاتيح
   'pos-invoices' و 'pos-inventory' (النظام القديم)، ننقلها تلقائياً للجداول
   الجديدة بدون أي فقدان بيانات، ثم نحذف النسخة القديمة من جدول storage. */
function migrateLegacyBlobsIfNeeded() {
  try {
    const invCount = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
    if (invCount === 0) {
      const row = db.prepare('SELECT value FROM storage WHERE key = ? AND shared = 0').get('pos-invoices');
      if (row && row.value) {
        const oldInvoices = JSON.parse(row.value);
        if (Array.isArray(oldInvoices) && oldInvoices.length) {
          const insertInv = db.prepare(`INSERT INTO invoices
            (id, number, date, cashier, customer, customer_id, method, subtotal, discount, tax, final, received, change, note, returned, returned_at, returned_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
          const insertLine = db.prepare(`INSERT INTO invoice_lines
            (invoice_id, product_id, name, qty, unit_price, addons_total, addons_names, note) VALUES (?,?,?,?,?,?,?,?)`);
          const txn = db.transaction(() => {
            oldInvoices.forEach(inv => {
              insertInv.run(inv.id, inv.number, inv.date, inv.cashier, inv.customer, inv.customerId || null, inv.method,
                inv.subtotal, inv.discount, inv.tax, inv.final, inv.received, inv.change, inv.note || '',
                inv.returned ? 1 : 0, inv.returnedAt || null, inv.returnedBy || null);
              (inv.lines || []).forEach(l => {
                insertLine.run(inv.id, l.productId || null, l.name, l.qty, l.unitPrice, l.addonsTotal || 0, l.addonsNames || '', l.note || '');
              });
            });
          });
          txn();
          db.prepare('DELETE FROM storage WHERE key = ? AND shared = 0').run('pos-invoices');
          console.log(`تمت ترقية ${oldInvoices.length} فاتورة بيع إلى الجدول الجديد`);
        }
      }
    }
  } catch (e) { console.error('migrate invoices error', e); }

  try {
    const pCount = db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c;
    if (pCount === 0) {
      const row = db.prepare('SELECT value FROM storage WHERE key = ? AND shared = 0').get('pos-inventory');
      if (row && row.value) {
        const d = JSON.parse(row.value);
        const oldPurchases = d.purchaseInvoices;
        if (Array.isArray(oldPurchases) && oldPurchases.length) {
          const insertP = db.prepare(`INSERT INTO purchase_invoices (id, date, supplier_id, supplier, payment_type, total) VALUES (?,?,?,?,?,?)`);
          const insertL = db.prepare(`INSERT INTO purchase_invoice_lines
            (purchase_invoice_id, product_id, ing_id, name, qty, cost, sell_price, total) VALUES (?,?,?,?,?,?,?,?)`);
          const txn = db.transaction(() => {
            oldPurchases.forEach(pinv => {
              insertP.run(pinv.id, pinv.date, pinv.supplierId || null, pinv.supplier, pinv.paymentType, pinv.total);
              (pinv.lines || []).forEach(l => {
                insertL.run(pinv.id, l.productId || null, l.ingId || null, l.name, l.qty, l.cost, (l.sellPrice == null ? null : l.sellPrice), l.total);
              });
            });
          });
          txn();
          const now = new Date().toISOString();
          db.prepare(`INSERT INTO storage (key, shared, value, updated_at) VALUES (?,0,?,?)
            ON CONFLICT(key, shared) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
            .run('pos-inventory', JSON.stringify({ inventoryItems: d.inventoryItems || [] }), now);
          console.log(`تمت ترقية ${oldPurchases.length} فاتورة شراء إلى الجدول الجديد`);
        }
      }
    }
  } catch (e) { console.error('migrate purchases error', e); }
}

/* ---------------- النسخ الاحتياطي التلقائي ---------------- */
function pruneOldBackups(dir, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.db'))
      .sort(); // الاسم يبدأ بالتاريخ، فالترتيب الأبجدي = ترتيب زمني
    while (files.length > keep) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch (e) {}
    }
  } catch (e) { console.error('prune backups error', e); }
}

async function runBackup() {
  try {
    const dir = getBackupsDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `pos-backup-${stamp}.db`);
    await db.backup(dest); // نسخ آمن أثناء التشغيل (Online Backup API الخاصة بـ SQLite)
    pruneOldBackups(dir, 30); // الاحتفاظ بآخر 30 نسخة فقط
  } catch (e) {
    console.error('backup failed', e);
  }
}

/* ---------------- النافذة الرئيسية ---------------- */
const APP_BUILD_VERSION = '2026-07-13-fix3';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'نظام الكاشير - محل الساندويشات (إصدار ' + APP_BUILD_VERSION + ')',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');
}

/* ---------------- واجهات IPC (تحل محل localStorage) ---------------- */
ipcMain.handle('storage:get', (event, key, shared) => {
  const row = db.prepare('SELECT value FROM storage WHERE key = ? AND shared = ?')
    .get(key, shared ? 1 : 0);
  if (!row) throw new Error('key not found');
  return { key, value: row.value, shared: !!shared };
});

ipcMain.handle('storage:set', (event, key, value, shared) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO storage (key, shared, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key, shared) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, shared ? 1 : 0, value, now);
  return { key, value, shared: !!shared };
});

ipcMain.handle('storage:delete', (event, key, shared) => {
  const info = db.prepare('DELETE FROM storage WHERE key = ? AND shared = ?')
    .run(key, shared ? 1 : 0);
  return { key, deleted: info.changes > 0, shared: !!shared };
});

ipcMain.handle('storage:list', (event, prefix, shared) => {
  const rows = db.prepare('SELECT key FROM storage WHERE shared = ? AND key LIKE ?')
    .all(shared ? 1 : 0, (prefix || '') + '%');
  return { keys: rows.map(r => r.key), prefix: prefix || '', shared: !!shared };
});

/* ---------------- واجهات فواتير البيع (جدول حقيقي) ---------------- */
ipcMain.handle('invoices:getAll', () => {
  const invRows = db.prepare('SELECT * FROM invoices ORDER BY date DESC').all();
  const lineRows = db.prepare('SELECT * FROM invoice_lines ORDER BY id ASC').all();
  const linesByInvoice = {};
  for (const l of lineRows) {
    (linesByInvoice[l.invoice_id] = linesByInvoice[l.invoice_id] || []).push({
      productId: l.product_id, name: l.name, qty: l.qty, unitPrice: l.unit_price,
      addonsTotal: l.addons_total, addonsNames: l.addons_names, note: l.note
    });
  }
  return invRows.map(r => ({
    id: r.id, number: r.number, date: r.date, cashier: r.cashier,
    customer: r.customer, customerId: r.customer_id, method: r.method,
    lines: linesByInvoice[r.id] || [],
    subtotal: r.subtotal, discount: r.discount, tax: r.tax, final: r.final,
    received: r.received, change: r.change, note: r.note,
    returned: !!r.returned, returnedAt: r.returned_at || undefined, returnedBy: r.returned_by || undefined
  }));
});

ipcMain.handle('invoices:add', (event, inv) => {
  try {
    // نبني قائمة القيم أولاً، ثم نولّد عدد علامات (?) تلقائياً من طولها نفسه —
    // بهذا الشكل يستحيل تقنياً أن يختلف عدد الأماكن الفاضية عن عدد القيم أبداً.
    const invColumns = ['id','number','date','cashier','customer','customer_id','method',
      'subtotal','discount','tax','final','received','change','note','returned'];
    const invValues = [inv.id, inv.number, inv.date, inv.cashier, inv.customer, inv.customerId || null, inv.method,
      inv.subtotal, inv.discount, inv.tax, inv.final, inv.received, inv.change, inv.note || '', inv.returned ? 1 : 0];
    const invPlaceholders = invColumns.map(() => '?').join(',');
    const insertInv = db.prepare(`INSERT INTO invoices (${invColumns.join(', ')}) VALUES (${invPlaceholders})`);

    const lineColumns = ['invoice_id','product_id','name','qty','unit_price','addons_total','addons_names','note'];
    const linePlaceholders = lineColumns.map(() => '?').join(',');
    const insertLine = db.prepare(`INSERT INTO invoice_lines (${lineColumns.join(', ')}) VALUES (${linePlaceholders})`);

    const txn = db.transaction(() => {
      insertInv.run(...invValues);
      (inv.lines || []).forEach(l => {
        const lineValues = [inv.id, l.productId || null, l.name, l.qty, l.unitPrice, l.addonsTotal || 0, l.addonsNames || '', l.note || ''];
        insertLine.run(...lineValues);
      });
    });
    txn();
    return true;
  } catch (err) {
    // نسجل نسخة الإصدار + بيانات الفاتورة الكاملة + الخطأ الأصلي بالتفصيل، مهما كان سبب الفشل
    logError(`invoices:add [إصدار الكود: ${APP_BUILD_VERSION}]`,
      `${err && err.stack ? err.stack : err}\n\nبيانات الفاتورة كما وصلت:\n${JSON.stringify(inv, null, 2)}`);
    throw err;
  }
});

ipcMain.handle('invoices:markReturned', (event, id, returnedAt, returnedBy) => {
  db.prepare('UPDATE invoices SET returned = 1, returned_at = ?, returned_by = ? WHERE id = ?')
    .run(returnedAt, returnedBy, id);
  return true;
});

/* ---------------- واجهات فواتير الشراء (جدول حقيقي) ---------------- */
ipcMain.handle('purchases:getAll', () => {
  const rows = db.prepare('SELECT * FROM purchase_invoices ORDER BY date DESC').all();
  const lineRows = db.prepare('SELECT * FROM purchase_invoice_lines ORDER BY id ASC').all();
  const byInv = {};
  for (const l of lineRows) {
    (byInv[l.purchase_invoice_id] = byInv[l.purchase_invoice_id] || []).push({
      productId: l.product_id || undefined, ingId: l.ing_id || undefined, name: l.name,
      qty: l.qty, cost: l.cost, sellPrice: l.sell_price, total: l.total
    });
  }
  return rows.map(r => ({
    id: r.id, date: r.date, supplierId: r.supplier_id, supplier: r.supplier,
    paymentType: r.payment_type, total: r.total, lines: byInv[r.id] || []
  }));
});

ipcMain.handle('purchases:add', (event, pinv) => {
  const insertP = db.prepare(`INSERT INTO purchase_invoices (id, date, supplier_id, supplier, payment_type, total) VALUES (?,?,?,?,?,?)`);
  const insertL = db.prepare(`INSERT INTO purchase_invoice_lines
    (purchase_invoice_id, product_id, ing_id, name, qty, cost, sell_price, total) VALUES (?,?,?,?,?,?,?,?)`);
  const txn = db.transaction(() => {
    insertP.run(pinv.id, pinv.date, pinv.supplierId || null, pinv.supplier, pinv.paymentType, pinv.total);
    (pinv.lines || []).forEach(l => {
      insertL.run(pinv.id, l.productId || null, l.ingId || null, l.name, l.qty, l.cost, (l.sellPrice == null ? null : l.sellPrice), l.total);
    });
  });
  txn();
  return true;
});

/* ---------------- تصفير البرنامج بالكامل (كأنه أول استخدام) ---------------- */
ipcMain.handle('program:resetAll', () => {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM storage').run();
    db.prepare('DELETE FROM invoices').run();
    db.prepare('DELETE FROM invoice_lines').run();
    db.prepare('DELETE FROM purchase_invoices').run();
    db.prepare('DELETE FROM purchase_invoice_lines').run();
  });
  txn();
  try { db.exec('VACUUM'); } catch (e) { /* غير حرج إذا فشل */ }
  return true;
});

/* ---------------- واجهات النسخ الاحتياطي ---------------- */
ipcMain.handle('backup:now', async () => { await runBackup(); return true; });
ipcMain.handle('backup:openFolder', () => { shell.openPath(getBackupsDir()); return true; });
ipcMain.handle('backup:info', () => ({ dbPath: getDbPath(), backupsDir: getBackupsDir() }));

/* ---------------- دورة حياة التطبيق ---------------- */
app.whenReady().then(() => {
  try {
    initDatabase();
    migrateLegacyBlobsIfNeeded();
  } catch (err) {
    logError('initDatabase', err);
    dialog.showErrorBox(
      'خطأ في تشغيل قاعدة البيانات',
      'تعذّر تشغيل قاعدة البيانات، لذلك لن يعمل حفظ الفواتير أو الأصناف.\n\n' +
      'الخطأ: ' + (err && err.message ? err.message : err) + '\n\n' +
      'تفاصيل إضافية محفوظة في ملف error-log.txt داخل مجلد بيانات البرنامج.\n' +
      'الحل المقترح: أعد تثبيت البرنامج (النسخة المطابقة لنظامك 32-bit أو 64-bit)، وتأكد من إغلاق أي نسخة أخرى من البرنامج مفتوحة.'
    );
  }
  createWindow();

  // نسخة احتياطية كل 6 ساعات أثناء تشغيل البرنامج
  backupTimer = setInterval(runBackup, 6 * 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// نسخة احتياطية أخيرة عند إغلاق البرنامج قبل إنهائه فعلياً
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  if (backupTimer) clearInterval(backupTimer);
  runBackup()
    .catch(err => console.error(err))
    .finally(() => {
      try { if (db) db.close(); } catch (e) {}
      app.quit();
    });
});
