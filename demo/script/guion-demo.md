# Guion de la demo — 5 a 6 minutos, todo en vivo desde la herramienta

Sin capturas: se muestra la extensión funcionando. Cada paso tiene qué hacer, qué decir y qué puede salir mal.
Los textos entre comillas son lo que diría en voz alta (en el idioma de la presentación; aquí en español).

## Antes de entrar (hacerlo 10 min antes, no en vivo)
- [ ] **Instalar la versión final** de la extensión y recargar VS Code. No instalar nada nuevo después del 4 nov.
- [ ] **Proxy encendido** y un terminal nuevo de VS Code (así `ANTHROPIC_BASE_URL` apunta al proxy). Comprobar la barra de estado.
- [ ] **Caché caliente:** hacer una petición corta con `claude` 1–2 min antes. Si la primera petición de la demo cae en caché fría, escribe la caché completa y se ve cara (eso es real, pero distrae).
- [ ] **Rango del dashboard:** dejar "This month" o "Last 7 days", para que se vea el titular con datos. "Today" sin actividad sale vacío.
- [ ] **Nombre del repo:** si el filtro de Repo muestra `core-banking`, filtrar por otro o anonimizar. Decidir antes (pendiente).
- [ ] **Tamaño de pantalla:** zoom de VS Code al 125 % para que se lea desde atrás; cerrar paneles y notificaciones.
- [ ] **Prompt de la demo preparado** en un archivo de notas (ver paso 2). No improvisar.
- [ ] **Video de respaldo** abierto en otra ventana, listo para reproducir.
- [ ] Wi-Fi y VPN comprobados; cuota disponible (la petición real consume).

---

## Paso 0 — Abrir el dashboard (≈ 30 s)
**Hacer:** `Ctrl+Shift+P` → **Claude: Show Dashboard (Token Improver tab)**.
Aparece la pantalla de carga con el título *Welcome to Claude Budget Advisor* mientras llegan los datos.

**Decir:** "Esto es la extensión dentro de VS Code. El proxy ya está corriendo; el desarrollador solo trabaja con Claude Code como siempre."

> Si la cuenta tuviera la pestaña Budget (cuentas Pro) saldría ahí por defecto; en Enterprise solo existe Token Improver.

---

## Paso 1 — El titular de ahorro (≈ 1 min 30 s)
**Hacer:** señalar la cifra de ahorro de arriba y las dos tendencias (el rango filtrado y el mes).

**Decir:**
- "Arriba está lo que importa: cuánto estamos ahorrando frente a lo que habría costado sin el proxy."
- "Las dos gráficas muestran cómo se movió ese porcentaje, por hora o por día, y el acumulado."
- Si hay días flojos: "Hay días con poco o negativo. Una caché fría cuesta escribirla otra vez. Por eso miramos el mes, no el día."

**Cuidado:** las cifras del ledger (26–32 %) no son el 23.5 % de la factura. Si alguien lo nota: "La factura real es 23.5 %; esto es la estimación del propio ledger, comparada con lo que habría costado el mismo trabajo sin proxy."

---

## Paso 2 — Una petición real, en vivo (≈ 2 min 30 s)
**Hacer:**
1. Cambiar al terminal, ejecutar un prompt **corto y barato** de los que dejó preparados (ej. "Explica qué hace `src/proxy/keepAlive.ts` en tres frases" sobre este mismo repo).
2. Volver al dashboard, sin recargar: la fila aparece en **Processing**, con el icono animado y la flecha viajando hacia Anthropic.
3. Cuando termine, **expandir** el chat → el turn → el hit.
4. Recorrer las columnas de izquierda a derecha, con el ratón sobre cada una:
   - **Raw:** "lo que Claude Code quería enviar."
   - **Cleanup / Summarized:** "lo que el proxy quitó antes de enviarlo."
   - **Sent / Received:** "lo que Anthropic procesó de verdad."
   - **CR / CW / RI:** "cuánto vino de caché, cuánto se escribió y cuánto fue entrada normal."
   - **Billed:** "lo que realmente cobró Anthropic, en unidades."

**Decir:** "Cada petición pasa por aquí de ida y vuelta. Esta es la misma ruta del diagrama, pero con datos reales."

**Si el resumen de Haiku no se dispara** (lo normal en un prompt corto): decirlo tal cual. "En este turno no hizo falta resumir. Se activa cuando el historial es largo y la caché está fría; aquí, uno de esos turnos del día." y abrir un turn anterior donde sí hubo resumen (marcado ✓ en Summarized). **Dejar elegido de antemano cuál.**

**Cuidado:** si Anthropic tarda, no rellenar con el silencio: pasar a mostrar una fila ya terminada y volver después.

---

## Paso 3 — El número se puede comprobar (≈ 1 min)
**Hacer:** pasar el ratón sobre la cifra principal de ahorro: sale el tooltip con la fórmula. Luego sobre **Received** y **Raw** de la fila de totales.

**Decir:**
- "Cualquier número del panel se puede verificar. Este dice: ahorro = 1 − lo facturado ÷ lo que habría costado sin proxy, y desglosa cada parte."
- "Lo facturado sale de lo que Anthropic reporta. Lo de 'sin proxy' es una estimación, y el panel lo dice."

**Decir también (honesto):** "La estimación sin proxy supone un cliente con caché razonable. Por eso la cifra que más confianza me da es la de la factura."

---

## Cierre de la demo (≈ 20 s)
"Eso es todo: el proxy trabaja solo, y el panel deja revisar cada petición y cada cifra. Vuelvo a las diapositivas para el impacto."

---

## Si algo falla
| Problema | Qué hacer |
|---|---|
| El proxy no está corriendo / barra de estado en error | `Claude Token Improver: Start Proxy` desde la paleta; si no sube en 20 s, pasar al **video de respaldo** sin disculparse. |
| La petición real no llega (red, cuota, límite) | Mostrar una fila ya terminada del día y explicar el recorrido sobre ella. Decir "esta petición ya pasó". |
| El panel sale vacío | Cambiar el filtro de rango a "This month". Si sigue vacío, video de respaldo. |
| Una cifra no coincide con la diapositiva | No discutir el detalle en vivo: "Esa es la estimación del ledger; la cifra de la factura es la de la diapositiva." |
| Pregunta técnica que no sabe | "No lo medí; lo anoto y se lo confirmo." Mejor que inventar. |

## Tiempos
| Paso | Tiempo |
|---|---|
| 0. Abrir el dashboard | 0:30 |
| 1. Titular de ahorro | 1:30 |
| 2. Petición real en vivo | 2:30 |
| 3. Verificar un número | 1:00 |
| Cierre | 0:20 |
| **Total** | **≈ 5:50** |

## Para el video de respaldo
Grabar los mismos pasos 0–3, sin audio o con el guion encima, de 4–5 min. Usar el mismo prompt y el mismo repo. Guardarlo en `demo/script/respaldo.mp4` y tener una copia local; no depender de un enlace.
