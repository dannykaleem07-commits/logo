"""Phone access: pairing, PIN, sessions, QR codes, the web-app manifest and optional HTTPS.

The hub normally answers only the computer it runs on. With HUB_ALLOW_LAN=true (or `hub --phone`) it
also answers the office Wi-Fi, but a phone must be paired first: by scanning the QR code the Director
opens in Settings -> Phone on the office computer, or by entering the PIN. A paired phone gets an
HttpOnly cookie that lasts 90 days. Everything a phone can do, it does with the same approvals.
"""

import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
import socket
import threading
import time
from datetime import datetime, timedelta, timezone

from . import config, store

log = logging.getLogger("agents")

SESSION_COOKIE = "hub_s"
SESSION_DAYS = 90
PAIR_MINUTES = 10
MAX_SESSIONS = 12

_lock = threading.Lock()
_pair = {}                               # pairing token -> expiry (one live code at a time, single use)
_fails = {"count": 0, "until": 0.0}      # PIN lockout. One counter for the whole LAN: per-address would be spoofable.
_hosts = {"at": 0.0, "set": frozenset()}


# ---------------------------------------------------------------- addresses

def is_loopback(ip):
    ip = (ip or "").split("%")[0]
    if ip.startswith("::ffff:"):
        ip = ip[7:]
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


def local_ips():
    """This computer's network addresses, most useful first (no loopback, no link-local)."""
    found = []
    try:  # the address used to reach the network; no packet is sent
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("198.51.100.1", 9))
            found.append(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    try:
        found += socket.gethostbyname_ex(socket.gethostname())[2]
    except (socket.gaierror, OSError):
        pass
    out = []
    for ip in found:
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if a.is_loopback or a.is_link_local or a.is_unspecified or a.is_multicast or ip in out:
            continue
        out.append(ip)
    return out


def hostnames():
    names = []
    try:
        h = socket.gethostname().strip().lower().rstrip(".")
        if re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", h):
            names += [h, h + ".local"]
    except OSError:
        pass
    return names


def allowed_hosts():
    """Host headers we answer (defeats DNS rebinding). Refreshed every minute."""
    now = time.time()
    if now - _hosts["at"] > 60:
        s = {"localhost", "127.0.0.1", "[::1]", "::1"} | set(local_ips()) | set(hostnames()) | set(config.HUB_EXTRA_HOSTS)
        _hosts.update(at=now, set=frozenset(s))
    return _hosts["set"]


def host_of(header):
    """'192.168.1.20:8765' -> '192.168.1.20';  '[::1]:8765' -> '[::1]'."""
    h = (header or "").strip().lower()
    if h.startswith("["):
        return h.split("]")[0] + "]"
    return h.split(":")[0]


# ---------------------------------------------------------------- PIN

def pin():
    """The phone PIN: HUB_PIN from .env, or one generated once and kept in the database."""
    if config.HUB_PIN:
        return config.HUB_PIN
    saved = store.get("phone_pin")
    if not saved:
        saved = f"{secrets.randbelow(10 ** 6):06d}"
        store.put("phone_pin", saved)
    return saved


def pin_fixed():
    return bool(config.HUB_PIN)


def check_pin(candidate):
    """Returns (ok, retry_in_seconds). After 5 wrong tries the PIN is locked for 30s, doubling each time."""
    now = time.time()
    with _lock:
        if now < _fails["until"]:
            return False, int(_fails["until"] - now) + 1
        ok = hmac.compare_digest(re.sub(r"\D", "", str(candidate or ""))[:12].encode(), pin().encode())
        if ok:
            _fails.update(count=0, until=0.0)
            return True, 0
        _fails["count"] += 1
        if _fails["count"] >= 5:
            wait = min(600, 30 * 2 ** (_fails["count"] - 5))
            _fails["until"] = now + wait
            log.warning("Phone PIN: %d wrong attempts, locked for %ds", _fails["count"], wait)
            return False, wait
        return False, 0


# ---------------------------------------------------------------- sessions (hashed, in the database)

def _sessions():
    try:
        return json.loads(store.get("phone_sessions") or "{}")
    except ValueError:
        return {}


def _h(token):
    return hashlib.sha256(token.encode()).hexdigest()


def new_session(user_agent=""):
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock:
        s = {k: v for k, v in _sessions().items() if now - v.get("created", 0) < SESSION_DAYS * 86400}
        s[_h(token)] = {"created": now, "last": now, "device": device_name(user_agent)}
        for k in sorted(s, key=lambda k: s[k]["created"])[:-MAX_SESSIONS]:
            del s[k]
        store.put("phone_sessions", json.dumps(s))
    return token


def valid_session(token):
    if not token or len(token) > 128:
        return False
    h = _h(token)
    now = time.time()
    with _lock:
        s = _sessions()
        for k, v in s.items():
            if hmac.compare_digest(k, h):
                if now - v.get("created", 0) > SESSION_DAYS * 86400:
                    del s[k]
                    store.put("phone_sessions", json.dumps(s))
                    return False
                if now - v.get("last", 0) > 3600:
                    v["last"] = now
                    store.put("phone_sessions", json.dumps(s))
                return True
    return False


def forget_sessions():
    """Signs every phone out (the Director can do this from the office computer)."""
    with _lock:
        store.put("phone_sessions", "{}")


def device_name(user_agent):
    ua = user_agent or ""
    kind = "iPhone" if "iPhone" in ua else "iPad" if "iPad" in ua else "Android phone" if "Android" in ua else "device"
    return kind


def cookie_header(token, secure):
    # Lax, not Strict: Safari withholds Strict cookies on the navigation that follows a QR-code open from the
    # Camera app and on Home Screen launches. Writes are still protected by the Origin check in the hub.
    return (f"{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax"
            + ("; Secure" if secure else ""))


def cookie_token(header):
    for part in (header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == SESSION_COOKIE:
            return v.strip()
    return None


# ---------------------------------------------------------------- pairing codes (QR)

def new_pair_token():
    with _lock:
        _pair.clear()
        t = secrets.token_urlsafe(24)
        _pair[t] = time.time() + PAIR_MINUTES * 60
    return t


def redeem_pair_token(t):
    """True once per token, within its 10 minutes."""
    if not t or len(t) > 64:
        return False
    with _lock:
        for k in list(_pair):
            if hmac.compare_digest(k, t):
                exp = _pair.pop(k)
                return exp >= time.time()
    return False


def qr_svg(text):
    try:
        import segno
    except ImportError:
        return None
    return segno.make(text, error="m").svg_inline(scale=5, border=2, dark="#0A0B10", light=None, omitsize=True)


# ---------------------------------------------------------------- what the desktop shows in Settings -> Phone

def info(https_on):
    lan = bool(config.HUB_ALLOW_LAN)
    ips = local_ips()
    urls = [f"http://{ip}:{config.HUB_PORT}" for ip in ips]
    for h in hostnames()[1:]:  # the .local name, as a second option
        urls.append(f"http://{h}:{config.HUB_PORT}")
    pair_url = f"{urls[0]}/pair?t={new_pair_token()}" if lan and ips else None
    hint = ""
    if not lan:
        hint = ("The hub is only answering this computer. Start it with  python -m claims_agents hub --phone  "
                "(or set HUB_ALLOW_LAN=true in .env) and come back here. Pair the phone in Safari: only Safari can "
                "install the certificate for voice, and only a Safari tab can use the microphone.")
    elif not ips:
        hint = "No network address found. Is this computer connected to the office Wi-Fi or network?"
    return {
        "lan": lan,
        "urls": urls,
        "pair_url": pair_url,
        "qr_svg": qr_svg(pair_url) if pair_url else None,
        "https": bool(https_on and ips),
        "https_url": f"https://{ips[0]}:{config.HUB_HTTPS_PORT}" if https_on and ips else None,
        "ca_url": f"{urls[0]}/ca.crt" if https_on and ips else None,
        "pin": pin(),
        "pin_fixed": pin_fixed(),
        "hint": hint,
        "devices": sorted(({"device": v.get("device", "device"), "since": datetime.fromtimestamp(v.get("created", 0)).strftime("%d %b")}
                           for v in _sessions().values()), key=lambda d: d["since"]),
    }


def manifest():
    return {
        "name": "Boss Hub", "short_name": "Boss Hub", "id": "/", "start_url": "/", "scope": "/",
        "display": "standalone", "orientation": "any",
        "background_color": "#0A0B10", "theme_color": "#0A0B10",
        "description": "The Director's control room for the claims team.",
        "icons": [
            {"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png"},
        ],
    }


# ---------------------------------------------------------------- HTTPS (for the microphone on a phone)

def tls_files():
    """(cert, key, ca_cert) paths for the https server, made or renewed here. None if `cryptography` is missing.

    The CA is created once; the phone trusts it one time (Settings -> General -> About -> Certificate Trust
    Settings). The server certificate is remade whenever this computer's addresses change or it nears expiry,
    and follows Apple's rules: <= 825 days, a SAN for every address, SHA-256, serverAuth.
    """
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    except ImportError:
        return None

    d = config.DATA_DIR / "tls"
    d.mkdir(parents=True, exist_ok=True)
    ca_crt, ca_key, crt, key, meta = d / "boss-hub-ca.crt", d / "boss-hub-ca.key", d / "hub.crt", d / "hub.key", d / "hub.json"
    now = datetime.now(timezone.utc)

    def write_key(path, k):
        path.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                         serialization.NoEncryption()))
        try:
            path.chmod(0o600)
        except OSError:
            pass

    if not (ca_crt.exists() and ca_key.exists()):
        k = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Boss Hub Local CA"),
                          x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Boss Hub")])
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(k.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=3650))
                .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                             content_commitment=False, key_encipherment=False, data_encipherment=False,
                                             key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
                .add_extension(x509.SubjectKeyIdentifier.from_public_key(k.public_key()), critical=False)
                .sign(k, hashes.SHA256()))
        ca_crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        write_key(ca_key, k)
        log.info("Made a local certificate authority for the phone's secure address: %s", ca_crt)

    names = sorted(set(local_ips()) | {"127.0.0.1"}), sorted(set(hostnames()) | {"localhost"})
    fresh = False
    if crt.exists() and key.exists() and meta.exists():
        try:
            m = json.loads(meta.read_text())
            fresh = m.get("ips") == names[0] and m.get("names") == names[1] and \
                datetime.fromisoformat(m["expires"]) - now > timedelta(days=30)
        except (ValueError, KeyError):
            fresh = False
    if not fresh:
        ca = x509.load_pem_x509_certificate(ca_crt.read_bytes())
        cak = serialization.load_pem_private_key(ca_key.read_bytes(), None)
        k = ec.generate_private_key(ec.SECP256R1())
        san = [x509.IPAddress(ipaddress.ip_address(ip)) for ip in names[0]] + [x509.DNSName(h) for h in names[1]]
        expires = now + timedelta(days=820)
        cert = (x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Boss Hub")]))
                .issuer_name(ca.subject).public_key(k.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(days=1)).not_valid_after(expires)
                .add_extension(x509.SubjectAlternativeName(san), critical=False)
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=True, key_agreement=True,
                                             content_commitment=False, data_encipherment=False, key_cert_sign=False,
                                             crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(cak.public_key()), critical=False)
                .sign(cak, hashes.SHA256()))
        crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        write_key(key, k)
        meta.write_text(json.dumps({"ips": names[0], "names": names[1], "expires": expires.isoformat()}))
        log.info("Made the hub's https certificate for %s", ", ".join(names[0] + names[1]))
    return crt, key, ca_crt
