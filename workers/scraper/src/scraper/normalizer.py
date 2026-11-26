from __future__ import annotations

import hashlib
import re
from typing import Iterable

from scraper.models import EmploymentType, JobCategory, WorkMode

TURKISH_CITIES: dict[str, str] = {
    "adana": "Adana",
    "adiyaman": "Adıyaman",
    "afyon": "Afyonkarahisar",
    "afyonkarahisar": "Afyonkarahisar",
    "agri": "Ağrı",
    "aksaray": "Aksaray",
    "amasya": "Amasya",
    "ankara": "Ankara",
    "antalya": "Antalya",
    "ardahan": "Ardahan",
    "artvin": "Artvin",
    "aydin": "Aydın",
    "balikesir": "Balıkesir",
    "bartin": "Bartın",
    "batman": "Batman",
    "bayburt": "Bayburt",
    "bilecik": "Bilecik",
    "bingol": "Bingöl",
    "bitlis": "Bitlis",
    "bolu": "Bolu",
    "burdur": "Burdur",
    "bursa": "Bursa",
    "canakkale": "Çanakkale",
    "cankiri": "Çankırı",
    "corum": "Çorum",
    "denizli": "Denizli",
    "diyarbakir": "Diyarbakır",
    "duzce": "Düzce",
    "edirne": "Edirne",
    "elazig": "Elazığ",
    "erzincan": "Erzincan",
    "erzurum": "Erzurum",
    "eskisehir": "Eskişehir",
    "gaziantep": "Gaziantep",
    "giresun": "Giresun",
    "gumushane": "Gümüşhane",
    "hakkari": "Hakkâri",
    "hatay": "Hatay",
    "igdir": "Iğdır",
    "isparta": "Isparta",
    "istanbul": "İstanbul",
    "izmir": "İzmir",
    "kahramanmaras": "Kahramanmaraş",
    "karabuk": "Karabük",
    "karaman": "Karaman",
    "kars": "Kars",
    "kastamonu": "Kastamonu",
    "kayseri": "Kayseri",
    "kilis": "Kilis",
    "kirikkale": "Kırıkkale",
    "kirklareli": "Kırklareli",
    "kirsehir": "Kırşehir",
    "kocaeli": "Kocaeli",
    "gebze": "Kocaeli",
    "konya": "Konya",
    "kutahya": "Kütahya",
    "malatya": "Malatya",
    "manisa": "Manisa",
    "mardin": "Mardin",
    "mersin": "Mersin",
    "mugla": "Muğla",
    "mus": "Muş",
    "nevsehir": "Nevşehir",
    "nigde": "Niğde",
    "ordu": "Ordu",
    "osmaniye": "Osmaniye",
    "rize": "Rize",
    "sakarya": "Sakarya",
    "samsun": "Samsun",
    "sanliurfa": "Şanlıurfa",
    "siirt": "Siirt",
    "sinop": "Sinop",
    "sirnak": "Şırnak",
    "sivas": "Sivas",
    "tekirdag": "Tekirdağ",
    "tokat": "Tokat",
    "trabzon": "Trabzon",
    "tunceli": "Tunceli",
    "usak": "Uşak",
    "van": "Van",
    "yalova": "Yalova",
    "yozgat": "Yozgat",
    "zonguldak": "Zonguldak",
}

_TR_FOLD_MAP = str.maketrans(
    {
        "ç": "c",
        "Ç": "c",
        "ğ": "g",
        "Ğ": "g",
        "ı": "i",
        "I": "i",
        "İ": "i",
        "ö": "o",
        "Ö": "o",
        "ş": "s",
        "Ş": "s",
        "ü": "u",
        "Ü": "u",
    }
)


def fold_tr(text: str | None) -> str:
    """Türkçe karakterleri ASCII'ye indirger, küçük harfe çevirir ve fazla boşlukları temizler."""
    if not text:
        return ""
    folded = text.translate(_TR_FOLD_MAP).lower()
    folded = re.sub(r"[^a-z0-9\s]", " ", folded)
    return re.sub(r"\s+", " ", folded).strip()


def normalize_city(location: str | None) -> str | None:
    if not location:
        return None
    folded = fold_tr(location)
    tokens = set(folded.split())
    for key, canonical in TURKISH_CITIES.items():
        if key in tokens or f" {key} " in f" {folded} ":
            return canonical
    if "turkey" in tokens or "turkiye" in tokens:
        return "Türkiye"
    return None


def is_turkey_location(location: str | None) -> bool:
    if not location:
        return False
    folded = fold_tr(location)
    if any(k in folded for k in ("turkey", "turkiye", " tr ", "tr,", ",tr")):
        return True
    return normalize_city(location) is not None


def detect_work_mode(*texts: str | None) -> WorkMode:
    combined = " ".join(fold_tr(t) for t in texts if t)
    if any(k in combined for k in ("hybrid", "hibrit")):
        return "hybrid"
    if any(k in combined for k in ("remote", "uzaktan", "evden", "work from home")):
        return "remote"
    if any(k in combined for k in ("onsite", "on site", "yerinde", "ofisten", "ofis")):
        return "onsite"
    return "unknown"


def detect_employment_type(*texts: str | None) -> EmploymentType:
    """Yalnızca kaynakta açıkça belirtiliyorsa tür döner; asla varsayılan tahmin yapmaz."""
    combined = " ".join(fold_tr(t) for t in texts if t)
    if any(k in combined for k in ("staj", "stajyer", "intern", "internship", "aday muhendis", "long term")):
        return "internship"
    if any(k in combined for k in ("yeni mezun", "new grad", "graduate program", "mt program", "management trainee")):
        return "new_grad"
    if any(k in combined for k in ("part time", "yari zamanli")):
        return "part_time"
    if any(k in combined for k in ("sozlesmeli", "contract", "freelance", "proje bazli")):
        return "contract"
    if any(k in combined for k in ("full time", "tam zamanli")):
        return "full_time"
    return "unknown"


_CATEGORY_RULES: list[tuple[JobCategory, Iterable[str]]] = [
    (
        "data_ai",
        (
            "data scientist",
            "data engineer",
            "data analyst",
            "veri bilimi",
            "veri analist",
            "machine learning",
            "yapay zeka",
            "deep learning",
            "ai engineer",
            "llm",
            "bi analyst",
        ),
    ),
    (
        "software",
        (
            "software",
            "yazilim",
            "developer",
            "web development",
            "backend",
            "frontend",
            "full stack",
            "fullstack",
            "devops",
            "sre",
            "cloud",
            "qa ",
            "test engineer",
            "test muhendis",
            "mobile",
            "ios",
            "android",
            "cyber",
            "siber",
            "guvenlik",
            "embedded",
            "gomulu",
        ),
    ),
    (
        "electronics",
        (
            "elektronik",
            "elektrik",
            "electrical",
            "electronics",
            "aviyonik",
            "avionics",
            "rf ",
            "fpga",
            "pcb",
            "donanim",
            "hardware",
            "kontrol",
            "otomasyon",
        ),
    ),
    (
        "mechanical",
        (
            "makine",
            "mechanical",
            "mekatronik",
            "mechatronics",
            "aerodinamik",
            "ucak",
            "uzay",
            "havacilik",
            "aerospace",
            "yapisal",
            "termodinamik",
            "cad",
            "solidworks",
        ),
    ),
    (
        "industrial",
        (
            "endustri",
            "industrial",
            "uretim",
            "production",
            "kalite",
            "quality",
            "tedarik",
            "supply chain",
            "lojistik",
            "planlama",
        ),
    ),
    ("product", ("product manager", "product owner", "urun yoneticisi", "urun yonetimi")),
    ("design", ("ui ux", "ux ", "ui ", "tasarim", "designer", "grafik", "graphic")),
    ("marketing", ("marketing", "pazarlama", "growth", "seo", "sosyal medya", "brand", "marka")),
    ("finance", ("finans", "finance", "muhasebe", "accounting", "denetim", "audit", "hazine", "ekonomi", "tax", "vergi", "mali")),
    ("hr", ("insan kaynaklari", "human resources", "talent acquisition", "ise alim", "recruiter", "people", "compensation", "benefits", "payroll", "bordro")),
    ("sales", ("satis", "sales", "account executive", "is gelistirme", "business development")),
    ("operations", ("operasyon", "operations", "musteri hizmetleri", "customer success", "destek")),
]


def detect_category(*texts: str | None) -> JobCategory:
    combined = f" {' '.join(fold_tr(t) for t in texts if t)} "
    for category, keywords in _CATEGORY_RULES:
        if any(kw in combined for kw in keywords):
            return category
    return "other"


def compute_dedupe_hash(company_name: str, title: str, city: str | None) -> str:
    """Çapraz kaynak kopya ilanları yakalamak için deterministik SHA-256 parmak izi."""
    c_norm = fold_tr(company_name)
    # Kurumsal ekleri temizle (A.Ş., Teknoloji vb. varyasyonlar)
    c_norm = re.sub(r"\b(as|a s|ltd|sti|inc|llc|teknoloji|technology|technologies|turkiye|turkey)\b", "", c_norm)
    c_norm = re.sub(r"\s+", " ", c_norm).strip() or fold_tr(company_name)

    t_norm = fold_tr(title)
    city_norm = fold_tr(city) or "tr"

    raw = f"{c_norm}|{t_norm}|{city_norm}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def strip_html(html: str | None) -> str | None:
    """
    HTML içeriğini hafif Markdown'a çevirir:
    - Önce <br>, <p>, <div>, <li>, <h1-h4> blok sınırlarını satır sonuna çevirir
      (böylece <strong> içindeki <br>/<p> etiketleri asla yutulmaz).
    - <strong>/<b> içindeki her satırı ayrı ayrı **koyu** yapar.
    """
    if not html:
        return None
    import html as html_lib

    text = re.sub(r"<(script|style)[^>]*>[\s\S]*?</\1>", "", html, flags=re.IGNORECASE)
    # 1) Blok ve satır sonlarını ÖNCE dönüştür
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<li[^>]*>", "\n- ", text, flags=re.IGNORECASE)
    text = re.sub(r"</li>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</(ul|ol)>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<(p|div|section|article)[^>]*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|section|article)>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(
        r"<h[1-4][^>]*>([\s\S]*?)</h[1-4]>",
        lambda m: f"\n\n### {re.sub(r'<[^>]+>', '', m.group(1)).strip()}\n\n"
        if re.sub(r"<[^>]+>", "", m.group(1)).strip()
        else "",
        text,
        flags=re.IGNORECASE,
    )

    # 2) <strong>/<b> içindeki her satırı ayrı ayrı **koyu** yap (satır sonlarını koru)
    def _bold_repl(m: re.Match[str]) -> str:
        inner = re.sub(r"<[^>]+>", "", m.group(2))
        lines = inner.split("\n")
        out = []
        for ln in lines:
            lead = " " if ln[:1].isspace() else ""
            trail = " " if ln[-1:].isspace() else ""
            core = ln.strip()
            out.append(f"{lead}**{core}**{trail}" if core else "")
        return "\n".join(out)

    text = re.sub(r"<(strong|b)[^>]*>([\s\S]*?)</\1>", _bold_repl, text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() or None
