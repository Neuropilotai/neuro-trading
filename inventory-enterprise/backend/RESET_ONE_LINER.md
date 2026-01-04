# Reset - One Liner

**Copy. Paste. Done.**

---

## Reset Everything (PDFs + Products)

```javascript
(async()=>{const t=localStorage.getItem('np_owner_jwt')||localStorage.getItem('NP_TOKEN');if(!t)return alert('No token!');if(!confirm('Delete ALL PDFs and Products?'))return;const r=await fetch('https://api.neuropilot.dev/api/admin/reset/target',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({confirm:'RESET',deleteOrderPdfs:true,clearInventoryProducts:true,dryRun:false})});const d=await r.json();alert(r.ok?'✅ Done!':'❌ '+d.error);if(r.ok)setTimeout(()=>location.reload(),2000);})();
```

**That's it. One line.**

---

## Preview First (Dry-Run)

Change `dryRun:false` to `dryRun:true` in the code above.

---

## Why So Complicated?

The endpoint is simple. The complexity came from:
- Safety documentation (good, but optional)
- Multiple guides (helpful, but you don't need them)
- Debug logs (can be removed)

**The actual reset is just one API call.**

---

**Stop reading. Use the code above.**

