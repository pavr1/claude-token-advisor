# Borrador de diapositivas — 5 de noviembre

Plantilla: `AI_Uncovered_Showcase_Template.pptx` (18 diapositivas). El texto de cada diapositiva va en inglés, como la plantilla; las notas están en español.
`[CONFIRMAR]` marca lo que no sé y debe llenar usted. Cifras: ver `demo/findings.md` y `demo/metrics/resumen-1-28-oct.md`.

Tiempo: la plantilla dice 12–17 min en total y el `README` del demo, 20 máx. Con el demo en vivo de 5–6 min, apunte a unos 15.

---

## 1. Portada (slide 1)
- **[ARENA] · [DATE]:** `[CONFIRMAR arena]` · 5 Nov 2026
- **Solution name:** Claude Budget Advisor & Token Improver
- **Presenter:** `[CONFIRMAR nombre]`
- **Role · Team:** `[CONFIRMAR]`

## 2. Instrucciones (slide 2) — **borrar**

## 3. Agenda (slide 3) — sin cambios
Ya trae las 5 secciones con sus tiempos.

## 4. Equipo (slide 4)
`[CONFIRMAR]` quién más presenta. Si solo usted: dejar una tarjeta y borrar las otras dos.
- **Name / Role:** `[CONFIRMAR]`
- **One line:** Built the proxy, the dashboard and measured the savings.

## 5. Portada sección 1 (slide 5) — sin cambios

## 6. The Challenge (slide 6) — 1–2 min
- **Title:** Claude Code costs a lot, and you only see it on the bill
- **The problem:** Claude Code resends the whole conversation on every step, so long sessions are paid in full again and again. Nobody sees what a prompt cost until the monthly invoice.
- **Big number:** `~$1,100` / per developer per month on Claude Code (Oct, two teammates working without the proxy)
- **The old process:**
  - Cost is invisible while you work
  - Long histories are billed in full each turn
  - A cold cache makes a single pause expensive (the cache expires after 5 minutes)

> Nota: los $1,116.07 (Chen) y $1,110.60 (Steve) son de la factura real; el promedio es $1,113.34. No presente los $1,100 como límite: sus límites son $1,200 y $1,300.

## 7. Portada sección 2 (slide 7) — sin cambios

## 8. The AI Solution (slide 8) — 2–3 min
- **Title:** A local proxy that shrinks every request and measures the saving
- **What we built:** A VS Code extension with a local proxy. Claude Code is pointed at it; the proxy optimizes each request before it reaches Anthropic and records what it really cost.
- **Key capabilities:**
  1. Summarizes old history with Haiku when it pays off
  2. Keeps the prompt cache warm and anchored
  3. Shows the real saving live, with every number explained
- **GAP-approved AI tools:** Claude Code · Claude Sonnet / Haiku · Anthropic API
- **Footer "Approved by the GAP Security Team":** `[CONFIRMAR]` que Claude Code está aprobado por GAP (el plan lo marca como pendiente). Si no se confirma, quitar esa línea.

> Nota de seguridad para preguntas: el proxy corre solo en `127.0.0.1`; sus credenciales se reenvían tal cual a Anthropic. El keep-alive guarda la credencial únicamente en memoria. Verificarlo antes de afirmarlo en voz alta.

## 9. Portada sección 3 (slide 9) — sin cambios

## 10. How It Works (slide 10) — 2–3 min
**Insertar el diagrama `how-it-works.png` ocupando la diapositiva** (no usar la maqueta de la plantilla con "Before / AI Intervention / After" a menos que quiera ambas cosas).

Si decide conservar la plantilla, el contenido sería:
- **Before:** Claude Code sends the full history every turn; you find the cost on the invoice.
- **AI Intervention:** The proxy cleans, summarizes with Haiku, routes simple turns, and anchors the cache.
- **After:** Smaller requests, 96 % cache reads, and a live dashboard of the real cost.
- **The human role:** Reviews the dashboard, sees what each request cost and why. Can pick any model with `/model`; the proxy respects it. Configuration (like cache TTL) is set once in VS Code settings.
- **Where AI adds value:** Haiku writes the summaries that replace long history.

> Recomendación: la diapositiva del diagrama sola. Explique de izquierda a derecha la ida, y de derecha a izquierda la vuelta. Dedique el tiempo a la etapa 2 (resumen Haiku), que es donde está el ahorro.

## 11. Portada sección 4 (slide 11) — sin cambios

## 12. Demo (slide 12) — 5–6 min
- **Title:** Claude Budget Advisor in action
- **Reemplazar el recuadro de captura** por un video corto de respaldo o por "LIVE" (usted lo muestra en la herramienta, sin capturas).
- **What you'll see:**
  1. The status bar and the dashboard headline: the saving so far
  2. One real request, live: Raw → Sent → Received → Billed
  3. Hover the saving figure: the formula behind the number

> Guion en `demo/script/` (pendiente de escribir). **Grabe un video de respaldo** de esos tres pasos antes del 4 nov, por si la demo en vivo falla. Cierre la sesión de `core-banking` o use otro repo para que no aparezca el nombre.

## 13. Portada sección 5 (slide 13) — sin cambios

## 14. Impact & Business Value (slide 14) — 2–3 min
- **Title:** About 23 % less spend, same goal, same month
- **Big numbers (3):**
  - `23.5 %` / less spend than two teammates without the proxy
  - `~$261` / saved in the month (vs. their average)
  - `96 %` / of cached tokens are cheap reads
- **BEFORE:** $1,113 average spend, two teammates without the proxy (Oct 1–28)
- **AFTER:** $852 with the proxy, and that figure also covers building the proxy itself with Claude, in parallel (Oct 1–28)
- **Pie pequeño:** "Source: Anthropic usage page, Oct 1–28. Ledger estimate: 26–32 % depending on the cache assumption."

> Nota: titular = 23.5 % de la **factura real**; es la cifra que no depende de ningún modelo. El ledger (26 % cota inferior, 32 % vs línea base) va de respaldo, nunca como titular.
> Diga de entrada los matices: cada quien eligió modelo y forma de trabajo; el $852 incluye además el consumo de trabajar en paralelo con Claude (desarrollar el propio proxy), que los compañeros no tuvieron; por eso el 23.5 % es una cifra conservadora; y el proxy fue mejorando durante el mes. **[CONFIRMAR]** que "en paralelo" es eso y no otro trabajo: lo interpreté a partir de `findings.md`.

## 15. Key Takeaways (slide 15)
1. **The saving comes from summarizing history, not from cleaning text.** Haiku summaries remove 29 % of tokens; text clean-up removes 0.06 %.
2. **Measure net, not gross.** Some days were negative (a cold cache costs more to write); only the month's total is honest.
3. **The cache is the lever.** 96 % reads, and the 5-minute expiry is the main leak, so a keep-alive ping is being tested. (Sin datos reales aún de su efecto: no decir que ya ahorra.)

## 16. Roadmap (slide 16)
`[CONFIRMAR]` — propuestas según lo que hay hoy:
- **NOW:** Working extension: proxy, live dashboard, per-request ledger. Used daily on a real project.
- **NEXT:** Pilot with more developers to confirm the saving beyond one user; validate the keep-alive over a full week.
- **LATER:** A team-wide view (today each machine keeps its own ledger).

## 17. Q&A (slide 17) — sin cambios

## 18. Gracias (slide 18)
- **Presenter:** `[CONFIRMAR]`
- **Email:** `[CONFIRMAR]@growthaccelerationpartners.com`

---

## Preguntas que probablemente le harán (preparar respuesta)
| Pregunta | Respuesta honesta |
|---|---|
| ¿El 23 % es por el proxy? | Los números lo respaldan, pero el uso no es idéntico. Por eso hay dos fuentes: factura (23.5 %) y ledger (26–32 %). |
| ¿Por qué el ledger y la factura no coinciden? | El ledger compara con una **estimación** de lo que habría costado sin proxy; la factura es real. |
| ¿Funciona con suscripción (no API)? | Las unidades son equivalentes API; en suscripción no se midió cuánto consume cada ping de keep-alive. |
| ¿Un solo usuario? | Sí, un usuario y un mes. Por eso el siguiente paso es un piloto. |
| ¿Se pierde calidad al resumir? | `[CONFIRMAR]` no hay medición de calidad en los datos. No afirmar nada que no se haya medido. |

## Pendientes antes del 4 nov
- [ ] Llenar los `[CONFIRMAR]` (nombre, arena, equipo, email, aprobación de GAP)
- [ ] Grabar video de respaldo de la demo
- [ ] Guion de la demo en `demo/script/`
- [ ] Decidir si se anonimiza `core-banking` en tablas y en la demo en vivo
- [ ] Enviar el deck al equipo de Educación (regla de la plantilla)
