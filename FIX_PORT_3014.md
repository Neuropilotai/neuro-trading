# Fix: Port 3014 Already in Use

## Quick Fix

Run this command to kill the process using port 3014:

```bash
kill -9 $(lsof -ti:3014)
```

Or if that doesn't work:

```bash
# Find the process
lsof -ti:3014

# Kill it (replace PID with the number from above)
kill -9 <PID>
```

## Then Start Again

```bash
./start_scalping_trading.sh
```

## Alternative: Use Different Port

If you want to keep the existing server running, you can use a different port:

```bash
export WEBHOOK_PORT=3015
node simple_webhook_server.js
```

## Check What's Running

To see what's using port 3014:

```bash
lsof -i:3014
```

This will show you the process name and PID.


