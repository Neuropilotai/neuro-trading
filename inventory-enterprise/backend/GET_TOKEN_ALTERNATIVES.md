# 🔑 Alternative Ways to Get Your Token

Since `localStorage.getItem('ownerToken')` returns `null` but the page is working, try these methods:

---

## Method 1: Get Token from Network Tab (Easiest!)

1. **Stay on:** `https://inventory-backend-production-3a2c.up.railway.app/console-v15.html`

2. **Open Developer Tools** (F12)

3. **Go to Network tab**

4. **Refresh the page** (F5) or **click any button** that loads data

5. **Find any API request** (look for requests to `/api/owner/` or `/api/admin/`)

6. **Click on the request**

7. **Go to Headers tab**

8. **Scroll down to "Request Headers"**

9. **Find `Authorization: Bearer ...`**

10. **Copy the token** (the part after `Bearer `)

Example:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImVtYWlsIjoi...
```
Copy everything after `Bearer ` (including the dots)

---

## Method 2: Check All localStorage Keys

In the Console tab, run these commands one by one:

```javascript
// See all keys
Object.keys(localStorage)

// Try each one
localStorage.getItem('ownerToken')
localStorage.getItem('token')
localStorage.getItem('authToken')
localStorage.getItem('NP_TOKEN')
localStorage.getItem('ownerUser')
```

---

## Method 3: Call the Page's Function Directly

In the Console tab, try:

```javascript
// Call the page's own function
getAuthToken()
```

This should return the token if the page has it stored.

---

## Method 4: Intercept Token from API Call

1. **Open Console tab**

2. **Type this code** (it will capture the token from the next API call):

```javascript
// Intercept fetch calls to get token
const originalFetch = window.fetch;
window.fetch = function(...args) {
    const [url, options] = args;
    if (options && options.headers && options.headers.Authorization) {
        const token = options.headers.Authorization.replace('Bearer ', '');
        console.log('🔑 TOKEN FOUND:', token);
        // Restore original fetch
        window.fetch = originalFetch;
        return originalFetch.apply(this, args);
    }
    return originalFetch.apply(this, args);
};

// Now trigger any action on the page (click refresh, etc.)
console.log('✅ Interceptor active. Click any button or refresh to capture token.');
```

3. **Click any button** on the page (like "Refresh" or any section)

4. **Check the console** - you should see `🔑 TOKEN FOUND: ...`

---

## Method 5: Check Cookies

Sometimes tokens are in cookies:

1. **Open Developer Tools** → **Application tab** (Chrome) or **Storage tab** (Firefox)

2. **Click "Cookies"** in the left sidebar

3. **Expand your domain**

4. **Look for any cookie** that might contain a token

---

## Method 6: Use Browser DevTools Application Tab

1. **Open Developer Tools** (F12)

2. **Go to Application tab** (Chrome) or **Storage tab** (Firefox)

3. **Click "Local Storage"** in the left sidebar

4. **Click your domain** (`inventory-backend-production-3a2c.up.railway.app`)

5. **Look at all key-value pairs**

6. **Find the token** (it will be a long string starting with `eyJ...`)

---

## Method 7: Create a Helper Function

In the Console tab, paste this:

```javascript
// Helper to find token
function findToken() {
    console.log('🔍 Searching for token...\n');
    
    // Check localStorage
    const keys = Object.keys(localStorage);
    console.log('📦 localStorage keys:', keys);
    
    for (const key of keys) {
        const value = localStorage.getItem(key);
        if (value && value.startsWith('eyJ')) {
            console.log(`✅ TOKEN FOUND in localStorage['${key}']:`, value);
            return value;
        }
    }
    
    // Check if getAuthToken exists
    if (typeof getAuthToken === 'function') {
        const token = getAuthToken();
        if (token) {
            console.log('✅ TOKEN FOUND via getAuthToken():', token);
            return token;
        }
    }
    
    console.log('❌ Token not found. Try Method 1 (Network tab).');
    return null;
}

// Run it
findToken();
```

---

## 🎯 Recommended: Method 1 (Network Tab)

**This is the most reliable method:**

1. Open Network tab
2. Refresh page or click any button
3. Find any API request
4. Check Headers → Authorization header
5. Copy the token

---

## ✅ Once You Have the Token

Use it in your curl commands:

```bash
# Replace YOUR_TOKEN_HERE with your actual token

# Step 1: Check analytics
curl https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/gfs-analytics \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"

# Step 2: Remove GFS data
curl -X POST https://inventory-backend-production-3a2c.up.railway.app/api/admin/sysco/remove-gfs-data \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "confirmation": "REMOVE_GFS",
    "createBackup": true
  }'
```

---

**Try Method 1 (Network Tab) first - it's the most reliable!** 🚀


