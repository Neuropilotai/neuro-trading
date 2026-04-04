import os
import pandas as pd
import yfinance as yf

DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)

def save_ticker_csv(ticker, interval, filename, period):
    df = yf.download(
        tickers=ticker,
        interval=interval,
        period=period,
        progress=False
    )

    if df.empty:
        print(f"No data for {ticker} {interval}")
        return

    df = df.reset_index()

    # Yahoo sometimes uses Date or Datetime
    time_col = "Datetime" if "Datetime" in df.columns else "Date"

    out = pd.DataFrame()
    out["timestamp"] = pd.to_datetime(df[time_col]).astype("int64") // 10**6
    out["open"] = df["Open"]
    out["high"] = df["High"]
    out["low"] = df["Low"]
    out["close"] = df["Close"]
    out["volume"] = df["Volume"]

    out = out.dropna()

    path = os.path.join(DATA_DIR, filename)
    out.to_csv(path, index=False)

    print(f"Saved {len(out)} rows -> {path}")


def main():
    save_ticker_csv("QQQ", "1m", "qqq_1m.csv", "7d")
    save_ticker_csv("QQQ", "5m", "qqq_5m.csv", "60d")
    save_ticker_csv("SPY", "1m", "spy_1m.csv", "7d")
    save_ticker_csv("SPY", "5m", "spy_5m.csv", "60d")


if __name__ == "__main__":
    main()
