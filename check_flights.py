import os
import sys
import json
from datetime import datetime
from pathlib import Path
import requests
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "docs" / "data" / "config.json"
HISTORY_PATH = BASE_DIR / "docs" / "data" / "price_history.json"

# ── Environment variables (set as GitHub Secrets) ─────────────────────────────
RAPIDAPI_KEY = os.environ.get("RAPIDAPI_KEY")
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY")
NOTIFY_EMAIL = os.environ.get("NOTIFY_EMAIL")
FROM_EMAIL = os.environ.get("FROM_EMAIL")


def load_config() -> dict:
    """Load search configuration from docs/data/config.json."""
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)


def load_history() -> dict:
    """Load existing price history."""
    if HISTORY_PATH.exists():
        with open(HISTORY_PATH, "r") as f:
            return json.load(f)
    return {"prices": []}


def save_history(history: dict):
    """Write price history back to file."""
    with open(HISTORY_PATH, "w") as f:
        json.dump(history, f, indent=2)
        f.write("\n")


def record_price(cheapest_price: int | None, cheapest_airline: str, num_results: int, config: dict):
    """Append today's price data to the history file."""
    history = load_history()
    today = datetime.now().strftime("%Y-%m-%d")

    # Avoid duplicate entries for the same day
    if history["prices"] and history["prices"][-1]["date"] == today:
        history["prices"].pop()

    entry = {
        "date": today,
        "cheapest_price": cheapest_price,
        "cheapest_airline": cheapest_airline,
        "num_results": num_results,
        "search_params": {
            "origin": config["origin"],
            "destination": config["destination"],
            "departure_date": config["departure_date"],
            "return_date": config["return_date"],
            "adults": config["adults"],
            "children": config["children"],
            "stops": config["stops"],
        },
    }
    history["prices"].append(entry)

    # Keep at most 365 days of data
    if len(history["prices"]) > 365:
        history["prices"] = history["prices"][-365:]

    save_history(history)
    print(f"  Recorded price history: {cheapest_price} EUR ({today})")


def search_roundtrip_flights(config: dict) -> dict:
    """Search for roundtrip flights using Google Flights via RapidAPI."""
    url = "https://google-flights-api.p.rapidapi.com/search-round-trip"
    params = {
        "departure_id": config["origin"],
        "arrival_id": config["destination"],
        "outbound_date": config["departure_date"],
        "return_date": config["return_date"],
        "adults": str(config["adults"]),
        "children": str(config["children"]),
        "stops": str(config["stops"]),
        "currency": "EUR",
        "hl": "en",
    }
    headers = {
        "x-rapidapi-host": "google-flights-api.p.rapidapi.com",
        "x-rapidapi-key": RAPIDAPI_KEY,
    }

    response = requests.get(url, headers=headers, params=params, timeout=30)
    response.raise_for_status()
    return response.json()


def extract_flight_info(flight: dict) -> dict:
    """Extract useful info from a single flight result."""
    legs = flight.get("legs", flight.get("flights", []))
    outbound_info = {}
    return_info = {}

    if len(legs) >= 1:
        out = legs[0]
        outbound_info = {
            "airline": out.get("airline", out.get("airline_name", "Unknown")),
            "departure_time": out.get("departure_time", out.get("departure", "")),
            "arrival_time": out.get("arrival_time", out.get("arrival", "")),
            "duration_min": out.get("duration", out.get("total_duration", 0)),
        }

    if len(legs) >= 2:
        ret = legs[1]
        return_info = {
            "airline": ret.get("airline", ret.get("airline_name", "Unknown")),
            "departure_time": ret.get("departure_time", ret.get("departure", "")),
            "arrival_time": ret.get("arrival_time", ret.get("arrival", "")),
            "duration_min": ret.get("duration", ret.get("total_duration", 0)),
        }

    return {
        "price": flight.get("price"),
        "outbound": outbound_info,
        "return": return_info,
    }


def find_flights(config: dict) -> list[dict]:
    """Search roundtrip flights and return all results with price info."""
    origin = config["origin"]
    destination = config["destination"]
    threshold = config["price_threshold_eur"]

    print(f"Searching roundtrip: {origin} ↔ {destination}")
    print(f"  Outbound: {config['departure_date']} | Return: {config['return_date']}")
    print(f"  Passengers: {config['adults']} adults, {config['children']} children")
    stops_label = "direct only" if config["stops"] == 0 else f"≤{config['stops']} stops"
    print(f"  {stops_label} | Threshold: {threshold} EUR\n")

    try:
        data = search_roundtrip_flights(config)
    except requests.RequestException as e:
        print(f"  Error searching flights: {e}")
        return []

    flights = data.get("flights", data.get("best_flights", []))
    other = data.get("other_flights", [])
    all_flights = flights + other

    print(f"  Found {len(all_flights)} roundtrip result(s)")

    results = []
    for flight in all_flights:
        info = extract_flight_info(flight)
        if info["price"] is not None:
            results.append(info)

    return results


def format_duration(minutes: int) -> str:
    if not minutes:
        return "N/A"
    return f"{minutes // 60}h {minutes % 60}m"


def send_email(cheap_flights: list[dict], config: dict):
    """Send an email notification with cheap roundtrip flight details."""
    origin = config["origin"]
    destination = config["destination"]
    threshold = config["price_threshold_eur"]

    subject = f"✈️ Flight Alert: {origin} ↔ {destination} roundtrip under {threshold} EUR!"

    rows = ""
    for f in sorted(cheap_flights, key=lambda x: x["price"]):
        o = f["outbound"]
        r = f["return"]
        rows += f"""
        <tr>
            <td style="padding:8px;border:1px solid #ddd"><strong>{f['price']} EUR</strong></td>
            <td style="padding:8px;border:1px solid #ddd">{o.get('airline', 'N/A')}</td>
            <td style="padding:8px;border:1px solid #ddd">{config['departure_date']}<br><small>{o.get('departure_time', '')} → {o.get('arrival_time', '')}</small></td>
            <td style="padding:8px;border:1px solid #ddd">{format_duration(o.get('duration_min', 0))}</td>
            <td style="padding:8px;border:1px solid #ddd">{r.get('airline', 'N/A')}</td>
            <td style="padding:8px;border:1px solid #ddd">{config['return_date']}<br><small>{r.get('departure_time', '')} → {r.get('arrival_time', '')}</small></td>
            <td style="padding:8px;border:1px solid #ddd">{format_duration(r.get('duration_min', 0))}</td>
        </tr>"""

    pax_desc = f"{config['adults']} adults"
    if config["children"]:
        pax_desc += f" + {config['children']} children"

    html_content = f"""
    <h2>✈️ {origin} ↔ {destination}</h2>
    <p><strong>Dates:</strong> {config['departure_date']} → {config['return_date']}</p>
    <p><strong>Passengers:</strong> {pax_desc}</p>
    <p><strong>Filter:</strong> {"Direct flights only" if config['stops'] == 0 else f"≤{config['stops']} stops"}</p>
    <p>Found <strong>{len(cheap_flights)}</strong> roundtrip flight(s) under {threshold} EUR:</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
        <tr style="background:#f2f2f2">
            <th style="padding:8px;border:1px solid #ddd" rowspan="2">Total Price</th>
            <th style="padding:8px;border:1px solid #ddd" colspan="3">Outbound ({origin} → {destination})</th>
            <th style="padding:8px;border:1px solid #ddd" colspan="3">Return ({destination} → {origin})</th>
        </tr>
        <tr style="background:#f9f9f9">
            <th style="padding:6px;border:1px solid #ddd">Airline</th>
            <th style="padding:6px;border:1px solid #ddd">Schedule</th>
            <th style="padding:6px;border:1px solid #ddd">Duration</th>
            <th style="padding:6px;border:1px solid #ddd">Airline</th>
            <th style="padding:6px;border:1px solid #ddd">Schedule</th>
            <th style="padding:6px;border:1px solid #ddd">Duration</th>
        </tr>
        {rows}
    </table>
    <p style="margin-top:16px">
        <a href="https://www.google.com/travel/flights?q=flights+from+{origin}+to+{destination}+on+{config['departure_date']}+return+{config['return_date']}"
           style="background:#1a73e8;color:white;padding:10px 20px;text-decoration:none;border-radius:4px">
            View on Google Flights
        </a>
    </p>
    <p style="color:#999;font-size:12px;margin-top:20px">
        Prices are roundtrip totals for {pax_desc}. Generated {datetime.now().strftime('%Y-%m-%d %H:%M UTC')}
    </p>
    """

    message = Mail(
        from_email=FROM_EMAIL,
        to_emails=NOTIFY_EMAIL,
        subject=subject,
        html_content=html_content,
    )

    sg = SendGridAPIClient(SENDGRID_API_KEY)
    response = sg.send(message)
    print(f"Email sent! Status: {response.status_code}")


def main():
    missing = []
    for var in ("RAPIDAPI_KEY", "SENDGRID_API_KEY", "NOTIFY_EMAIL", "FROM_EMAIL"):
        if not os.environ.get(var):
            missing.append(var)
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        sys.exit(1)

    # Load config
    config = load_config()
    threshold = config["price_threshold_eur"]

    # Search flights
    all_results = find_flights(config)

    # Record price history (always, even if no results)
    if all_results:
        cheapest = min(all_results, key=lambda x: x["price"])
        record_price(cheapest["price"], cheapest["outbound"].get("airline", ""), len(all_results), config)
    else:
        record_price(None, "", 0, config)

    # Filter for cheap flights and send email
    cheap_flights = [f for f in all_results if f["price"] <= threshold]

    if cheap_flights:
        print(f"\n{len(cheap_flights)} flight(s) under {threshold} EUR! Sending email…")
        send_email(cheap_flights, config)
    else:
        print(f"\nNo roundtrip flights found under {threshold} EUR. No email sent.")


if __name__ == "__main__":
    main()
