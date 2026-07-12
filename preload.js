const { contextBridge, ipcRenderer } = require('electron');

/* نفس واجهة window.storage التي يستخدمها التطبيق بالفعل (get/set/delete/list)
   لكنها الآن متصلة فعلياً بقاعدة بيانات SQLite في عملية main، وليس بمتصفح localStorage. */
contextBridge.exposeInMainWorld('storage', {
  get:    (key, shared)        => ipcRenderer.invoke('storage:get', key, !!shared),
  set:    (key, value, shared) => ipcRenderer.invoke('storage:set', key, value, !!shared),
  delete: (key, shared)        => ipcRenderer.invoke('storage:delete', key, !!shared),
  list:   (prefix, shared)     => ipcRenderer.invoke('storage:list', prefix, !!shared),
});

/* واجهة إضافية للنسخ الاحتياطي التلقائي */
contextBridge.exposeInMainWorld('backupAPI', {
  now:        () => ipcRenderer.invoke('backup:now'),
  openFolder: () => ipcRenderer.invoke('backup:openFolder'),
  info:       () => ipcRenderer.invoke('backup:info'),
});

/* فواتير البيع: جدول SQL حقيقي (صف لكل فاتورة) بدل نص JSON واحد،
   لأداء ثابت السرعة بغض النظر عن عدد الفواتير المتراكمة. */
contextBridge.exposeInMainWorld('invoicesAPI', {
  getAll:       ()                              => ipcRenderer.invoke('invoices:getAll'),
  add:          (invoice)                       => ipcRenderer.invoke('invoices:add', invoice),
  markReturned: (id, returnedAt, returnedBy)    => ipcRenderer.invoke('invoices:markReturned', id, returnedAt, returnedBy),
});

/* فواتير الشراء من الموردين: نفس المبدأ */
contextBridge.exposeInMainWorld('purchasesAPI', {
  getAll: ()          => ipcRenderer.invoke('purchases:getAll'),
  add:    (purchase)  => ipcRenderer.invoke('purchases:add', purchase),
});

/* تصفير البرنامج بالكامل */
contextBridge.exposeInMainWorld('programAPI', {
  resetAll: () => ipcRenderer.invoke('program:resetAll'),
});
