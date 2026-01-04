# Reset Tool - Simple One-Step Guide

**Stop. This is all you need.**

---

## 🎯 One-Step Reset (Browser Console)

1. **Open owner console** → Press F12 → Console tab
2. **Paste this code:**

```javascript
(async function() {
  const token = localStorage.getItem('np_owner_jwt') || localStorage.getItem('NP_TOKEN');
  if (!token) { alert('No token! Login first.'); return; }
  
  if (!confirm('⚠️ Delete ALL PDFs and Products?\n\nThis cannot be undone!')) return;
  
  const r = await fetch('https://api.neuropilot.dev/api/admin/reset/target', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      confirm: 'RESET',
      deleteOrderPdfs: true,
      clearInventoryProducts: true,
      dryRun: false
    })
  });
  
  const data = await r.json();
  console.log(data);
  alert(r.ok ? '✅ Done! Refreshing...' : '❌ Error: ' + data.error);
  if (r.ok) setTimeout(() => location.reload(), 2000);
})();
```

3. **Done.** That's it.

---

## 🔍 Want to Preview First? (Dry-Run)

Change `dryRun: false` to `dryRun: true` in the code above.

---

## ❓ Why So Many Files?

The complexity comes from:
- **Safety features** (dry-run, verification, backups)
- **Documentation** (for different use cases)
- **Troubleshooting guides** (for when things go wrong)

**But you only need the code above.**

---

**That's it. Everything else is optional.**

