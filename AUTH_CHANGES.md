# Authentifizierungs-Änderungen (v2.2.5 → v2.2.7)

> **Aktualisierung Juni 2026 – OAuth-2.0-Migration:** Autodarts schaltet Keycloak
> ab (Stichtag **28.06.2026**) und stellt auf einen neuen OAuth-2.0-Server
> (`https://api.autodarts.io`) mit **Authorization Code + PKCE** um.
> Der `grant_type=password` wird nicht mehr unterstützt. Wie sich das auf die
> Token-Erfassung der Extension auswirkt, ist unten unter
> [„OAuth-2.0-Migration (Juni 2026)"](#oauth-20-migration-juni-2026) beschrieben.

## OAuth-2.0-Migration (Juni 2026)

### Ausgangslage

Die Extension führt **keinen eigenen Login** durch. Sie hängt sich passiv an die
autodarts.io-Seite und greift den `access_token` ab, den die Seite selbst
bezieht – damit die Extension eigene authentifizierte API-Aufrufe machen kann
(z. B. Quick-Correction-PATCHes an `api.autodarts.io/gs/v0/...`). Die Extension
hat also **keine `client_id`** und hat nie `grant_type=password` verwendet – die
in der offiziellen Migrations-Anleitung beschriebenen Flows (Authorization Code,
Device Grant, Client Credentials) betreffen die Extension daher **nicht direkt**.

### Was bricht durch die Migration?

Der bisherige primäre Mechanismus überwachte ausschließlich den
**Keycloak-Token-Endpoint**
(`https://login.autodarts.io/realms/autodarts/protocol/openid-connect/token`).
Nach der Migration ruft die Seite diesen Endpoint nicht mehr auf, sondern den
neuen Server:

| Aktion | Neu |
|---|---|
| Code → Token (Exchange) | `https://api.autodarts.io/auth/v1/exchange` |
| Token-Refresh | `https://api.autodarts.io/auth/v1/refresh` |

Damit hätte die alte Erfassung **stillschweigend keinen Token mehr** geliefert.
Zusätzlich leben Access-Tokens jetzt nur noch **~15 Minuten** (Keycloak deutlich
länger), wodurch ein einmaliges Abgreifen beim Login schneller veraltet.

### Lösung (`entrypoints/auth-cookie.ts`)

| Aspekt | Vorher | Nachher |
|---|---|---|
| **Token-Endpoints** | nur Keycloak-Endpoint | Liste: neue Endpoints (`/auth/v1/exchange`, `/auth/v1/refresh`, `/auth/v1/token`, `/auth/v1/device/token`) **+** Keycloak (für das Übergangsfenster) |
| **`fetch`-Fallback** | nur Response-Body der Token-Endpoints | zusätzlich Abgreifen des `Authorization: Bearer ...`-Headers **jeder** ausgehenden `fetch`-Anfrage (endpoint-unabhängig) |
| **XHR-Fallback** | `Authorization: Bearer` aus `setRequestHeader` | unverändert |
| **Token-Refresh** | nur beim Token-Endpoint-Hit | jeder authentifizierte API-Call der Seite aktualisiert den gespeicherten Token → passt zur 15-Minuten-Lebensdauer |

Der entscheidende Robustheitsgewinn ist die **endpoint-unabhängige Erfassung aus
ausgehenden `Authorization`-Headern** (jetzt sowohl `fetch` als auch XHR): Egal
welcher Auth-Server im Einsatz ist – sobald die Seite einen authentifizierten
Request stellt, kennt die Extension den aktuellen Token. Der Keycloak-Endpoint
bleibt vorerst in der Liste, damit Nutzer im Übergangsfenster weiterhin
funktionieren.

Das `auth-cookie-available`-Event und die Speicherung in
`AutodartsToolsGlobalStatus.auth.token` bleiben **unverändert** – alle Consumer
(`getAuthToken`, `fetchWithAuth`, `QuickCorrection.vue`) funktionieren ohne
Anpassung weiter. Die Host-Permission `*://api.autodarts.io/*` deckt die neuen
Auth-Endpoints bereits ab; am Manifest ist keine Änderung nötig.

---

## Zusammenfassung

Ab Version 2.2.6 wurde der gesamte Authentifizierungsmechanismus grundlegend umgebaut. Der alte Ansatz las ein `Authorization`-Cookie aus dem Browser aus. Der neue Ansatz fängt stattdessen den JWT-Token direkt aus der Keycloak-OIDC-Token-Response ab, indem `window.fetch` überschrieben wird.

---

## Was hat sich geändert?

### 1. Token-Erfassung (`entrypoints/auth-cookie.ts`)

| Aspekt | Alt (≤ v2.2.5) | Neu (≥ v2.2.6) |
|---|---|---|
| **Methode** | Liest `document.cookie` nach einem Cookie namens `Authorization=` aus | Überschreibt `window.fetch` und fängt die Antwort des Keycloak-Token-Endpoints ab |
| **Token-Quelle** | Browser-Cookie | JSON-Response von `https://login.autodarts.io/realms/autodarts/protocol/openid-connect/token` → Feld `access_token` |
| **Fallback** | Keiner | Überschreibt zusätzlich `XMLHttpRequest.prototype.setRequestHeader` und extrahiert den Token aus ausgehenden `Authorization: Bearer ...`-Headern |
| **Deduplizierung** | Keine – Event wurde jedes Mal gefeuert | Token wird nur dispatcht, wenn er sich tatsächlich geändert hat (`lastToken`-Vergleich) |
| **Token-Refresh** | Nicht unterstützt – nur einmaliges Auslesen beim Laden | Automatisch – jeder neue Token-Endpoint-Response wird abgefangen, auch Token-Refreshes |
| **Custom Event** | `auth-cookie-available` mit `{ authValue }` | Gleiches Event, gleiche Struktur – abwärtskompatibel |

#### Alter Code (vereinfacht):
```ts
const authCookie = document.cookie
  .split("; ")
  .find(row => row.startsWith("Authorization="));
const authValue = authCookie.split("=")[1];
window.dispatchEvent(new CustomEvent("auth-cookie-available", {
  detail: { authValue },
}));
```

#### Neuer Code (vereinfacht):
```ts
const TOKEN_ENDPOINT = "https://login.autodarts.io/realms/autodarts/protocol/openid-connect/token";

const originalFetch = window.fetch;
window.fetch = function (...args) {
  const promise = originalFetch.apply(this, args);
  const url = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (url.startsWith(TOKEN_ENDPOINT)) {
    return promise.then((response) => {
      response.clone().json().then((body) => {
        if (body.access_token) dispatchToken(body.access_token);
      });
      return response;
    });
  }
  return promise;
};
```

### 2. API-Aufrufe – Authorization-Header (`utils/helpers.ts`)

| Aspekt | Alt (≤ v2.2.5) | Neu (≥ v2.2.6) |
|---|---|---|
| **Header** | `Cookie: Authorization=<token>` | `Authorization: Bearer <token>` |
| **Credentials** | `credentials: "include"` wurde gesetzt | Entfernt – nicht mehr nötig |

#### Alter Code:
```ts
headers.set("Cookie", `Authorization=${token}`);
return fetch(url, { ...options, headers, credentials: "include" });
```

#### Neuer Code:
```ts
headers.set("Authorization", `Bearer ${token}`);
return fetch(url, { ...options, headers });
```

### 3. Quick Correction API-Aufrufe (`entrypoints/match.content/QuickCorrection.vue`)

Alle direkten `fetch`-Aufrufe an die Autodarts-API verwendeten den Token ohne `Bearer`-Prefix:

```ts
// Alt:
"Authorization": await getAuthToken()

// Neu:
"Authorization": `Bearer ${await getAuthToken()}`
```

Dies betrifft **9 Stellen** in der Datei, an denen API-Requests für Wurf-Aktivierung, Wurf-Korrektur und Wurf-Deaktivierung gesendet werden.

### 4. Extension-Manifest (`wxt.config.ts`)

**In v2.2.6 hinzugefügt:**
- `*://login.autodarts.io/*` bei `host_permissions` (um den Token-Endpoint abfangen zu können)
- `cookies` bei `permissions`

**In v2.2.7 wieder entfernt:**
- Beide Einträge wurden wieder entfernt, da sie für den fetch-Intercept-Ansatz nicht benötigt werden (das Script läuft in der Main World der Seite selbst)

---

## Warum wurde das geändert?

1. **Cookie war unzuverlässig** – Autodarts hat offenbar aufgehört, den Token als `Authorization`-Cookie zu setzen, oder die Cookie-Verfügbarkeit war je nach Browser/Plattform inkonsistent.
2. **Korrekte HTTP-Authentifizierung** – Der `Authorization: Bearer <token>`-Header ist der OAuth2/OIDC-Standard. Das alte Setzen eines `Cookie`-Headers in einem `fetch`-Aufruf war ein Workaround, der in manchen Browsern durch CORS-Restrictions blockiert werden konnte.
3. **Automatischer Token-Refresh** – Da jetzt der Token-Endpoint abgefangen wird, bekommt die Extension automatisch jeden neuen Token mit, auch nach einem Token-Refresh durch Keycloak.

---

## Anpassungsanleitung für andere Projekte

Wenn du ein eigenes Projekt hast, das auf den Autodarts-Auth-Token zugreift, musst du folgende Änderungen vornehmen:

### Schritt 1: Token-Erfassung umstellen

Statt Cookies auszulesen, fange den Keycloak-Token-Endpoint ab:

```ts
const TOKEN_ENDPOINT = "https://login.autodarts.io/realms/autodarts/protocol/openid-connect/token";

const originalFetch = window.fetch;
window.fetch = function (...args) {
  const promise = originalFetch.apply(this, args);
  try {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    if (url.startsWith(TOKEN_ENDPOINT)) {
      return promise.then((response) => {
        response.clone().json().then((body) => {
          if (body.access_token) {
            // Hier deinen Token speichern
            myTokenStorage = body.access_token;
          }
        }).catch(() => {});
        return response;
      });
    }
  } catch (_) {}
  return promise;
};
```

**Wichtig:** Das Script muss in der **Main World** der Seite laufen (nicht in der isolierten Content-Script-Welt), damit es `window.fetch` der Seite überschreiben kann. In WXT/Chrome-Extensions geschieht das über ein `unlisted script`, das per `<script>`-Tag injiziert wird.

### Schritt 2: API-Aufrufe anpassen

Ersetze alle API-Aufrufe, die den Token verwenden:

```ts
// Alt – NICHT MEHR VERWENDEN:
headers.set("Cookie", `Authorization=${token}`);
fetch(url, { credentials: "include", headers });

// Neu – korrekter OAuth2-Standard:
headers.set("Authorization", `Bearer ${token}`);
fetch(url, { headers });
```

### Schritt 3: Bestehende Token-Nutzung prüfen

Falls du den Token direkt (ohne `Bearer`-Prefix) im `Authorization`-Header sendest, füge das Prefix hinzu:

```ts
// Alt:
"Authorization": token

// Neu:
"Authorization": `Bearer ${token}`
```

### Schritt 4: Cookie-Permissions entfernen (falls vorhanden)

Die `cookies`-Permission und `*://login.autodarts.io/*` Host-Permission werden nicht mehr benötigt und können aus dem Manifest entfernt werden.

### Optional: XHR-Fallback

Als zusätzliche Absicherung kann man auch ausgehende XHR-Requests abfangen:

```ts
const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  if (name.toLowerCase() === "authorization" && value.startsWith("Bearer ")) {
    myTokenStorage = value.slice(7); // "Bearer " entfernen
  }
  return originalSetRequestHeader.call(this, name, value);
};
```

---

## Betroffene Dateien

| Datei | Änderung |
|---|---|
| `entrypoints/auth-cookie.ts` | Komplett neu geschrieben – fetch-Intercept statt Cookie-Auslesen |
| `utils/helpers.ts` | `fetchWithAuth` nutzt jetzt `Authorization: Bearer` statt `Cookie`-Header |
| `entrypoints/match.content/QuickCorrection.vue` | `Bearer`-Prefix an 9 Stellen hinzugefügt |
| `wxt.config.ts` | v2.2.6: Permissions hinzugefügt → v2.2.7: wieder entfernt |
