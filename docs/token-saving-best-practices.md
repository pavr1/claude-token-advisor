# Buenas prácticas de ahorro de tokens (lado cliente / proxy)

Investigación del 2026-10-28. Objetivo: opciones de ahorro **del lado nuestro**, más allá del caché de Anthropic, y cómo encajan con el proxy (Token Improver).

**Convenciones del documento**
- **[Doc]** = afirmado en documentación oficial de Anthropic (consultada hoy). **[Repo]** = leído en `CLAUDE.md`/`findings.md`, *no* re-verificado en el código. **[Hipótesis]** = no medido.
- Sin dólares: solo tokens, unidades facturadas (tokens × multiplicador) y porcentajes. No se cita ninguna cifra de ahorro que no venga de la documentación; las de nuestro tool siguen la regla de ~34 % (F-03 – el ahorro mostrado no es defendible con los datos actuales).

---

## 1. Dónde se gastan los tokens (modelo mental)

1. Claude Code reenvía **toda la conversación en cada request**; cada tool call es otro request con todos los resultados previos. Con caché, esa historia se relee a 0.10x, pero **sigue creciendo** [Doc: costs].
2. El coste lo domina el **tamaño del contexto × número de requests**. Reducir cualquiera de los dos ahorra; el caché solo abarata el primero.
3. Los tokens de *thinking* se facturan como **salida** [Doc: costs/extended-thinking].
4. Un cache miss (pausa > TTL, prefijo cambiado) reprocesa todo el contexto a 1.25x (escritura) en vez de 0.10x (lectura) [Doc: prompt-caching].

Conclusión: las palancas propias son **(a) meter menos contenido al contexto, (b) sacar contenido viejo sin romper el caché más de lo que ahorra, (c) generar menos salida/thinking, (d) usar el modelo más barato suficiente, (e) no invalidar el caché**.

---

## 2. Mapa: lo que el proxy ya hace vs. lo que falta

| Palanca | Estado en el proxy [Repo] | Comentario |
|---|---|---|
| Normalizar strings para estabilidad del prefijo (etapa 1) | Hecho | Ver §3.5: añadir orden estable de claves y sin timestamps. |
| Compactación del chat con una llamada extra a Haiku (etapa 2) | Hecho, con fallo conocido | F-04 – la compactación falla en sesiones grandes (HTTP 400, tramo no cabe en Haiku). Ver §3.1 y §3.2: hoy hay alternativas server-side. |
| Ruteo de turnos cortos a Haiku (etapa 3) | Hecho | F-15 – ruteo a Haiku por regex (riesgo de mala respuesta). |
| Un solo ancla `cache_control` deslizante (etapa 4) | Hecho | Verificar contra la ventana de 20 bloques (§3.5). |
| Limpieza de tool results antiguos | **No existe** | Mayor oportunidad aislada (§3.1). |
| Control de thinking / effort / `max_tokens` | Parcial (solo al rutear a Haiku) | §3.4. |
| Poda de definiciones de tools | **No existe** | §3.3. |
| Medición real del caché por turno | Parcial (ledger + OTel) | §5. |

---

## 3. Técnicas, ordenadas por impacto esperado / coste de implementación

### 3.1 Limpieza de tool results antiguos (context editing) — **prioridad alta**
- **Qué es [Doc: context-editing]:** edición server-side `clear_tool_uses_20250919` que reemplaza los resultados de herramientas más viejos por un marcador, una vez superado un umbral. El cliente conserva el historial completo; no hay estado que sincronizar.
- **Parámetros:** `trigger` (default 100 000 input tokens), `keep` (default 3 tool uses recientes), `clear_at_least`, `exclude_tools`, `clear_tool_inputs`. Beta: header `anthropic-beta: context-management-2025-06-27`.
- **Por qué importa:** en sesiones de Claude Code la mayor parte del contexto son lecturas de archivos y salidas de Bash. Quitar las viejas reduce el tamaño de *todos* los requests siguientes.
- **Coste/riesgo [Doc]:** al limpiar se **invalida el prefijo cacheado** desde ese punto. Por eso existe `clear_at_least`: si no se libera lo suficiente, la edición no se aplica. Regla de decisión propuesta: limpiar solo cuando `(tokens liberados × 0.10 × turnos restantes esperados)` supere `tokens reescritos × 1.25` — comparado en **unidades facturadas** (regla 3). Los "turnos restantes" son **[Hipótesis]**; hay que medirlo en el ledger.
- **Cómo encajaría:** el proxy añade `context_management` al body de `POST /v1/messages` y el header beta. Respuesta trae `applied_edits.cleared_input_tokens` → dato directo y exacto para el ledger (ahorro *medido*, no estimado).
- **Casar con el momento de caché frío:** si el caché ya expiró (> `cacheTtl`), reescribir el prefijo es "gratis" porque se iba a reescribir igual. Es la misma lógica que ya usa la etapa 2 (`BaselineMemory`).
- **Pendiente de verificar:** que el cliente `claude` no mande ya su propio `context_management` (el prototipo respeta el del cliente si existe, pero no se comprobó en tráfico real).
- **Riesgo de caché con `keep` deslizante [Hipótesis, razonamiento mío, no medido]:** si cada turno de herramientas sigue limpiando un resultado más, el prefijo cambia en cada request y el ancla del turno anterior ya no coincide → miss completo en cada turno. La documentación solo dice que `clear_at_least` "protege el caché"; no explica si una limpieza ya aplicada se mantiene estable en los requests siguientes. Por eso el prototipo está apagado por defecto y registra `cleared` junto a cache read/written por turno: **hay que medirlo antes de recomendarlo.**
- **Estado de implementación (2026-10-28):** etapa 5 opt-in (`claudeTokenImprover.stage5ContextEditing`, default `false`; umbral 60K, `keep` 5, `clear_at_least` 20K), header beta agregado sin pisar los del cliente, y línea de log `context editing: cleared N tokens … cache read/written/uncached`. Sin persistencia en el ledger todavía.
- **Medido con tráfico real (2026-10-28, `claude -p` haiku vía proxy, 1 corrida por rama, lectura de 9 trozos de archivos):** (1) Claude Code ya envía `context_management` (`clear_thinking`, `keep: all`) y la beta; la primera versión se saltaba en ese caso y nunca se activaba. Corregido: ahora agrega `clear_tool_uses` a la lista. (2) Al dispararse limpió ~23.6K tokens; ese request pagó 36K tokens de escritura de caché y 32K de lectura (48K unidades, contra ~17K normales); el siguiente volvió a leer 68K del caché, así que **no** hay miss en cada turno. (3) Ahorro por request posterior: ~23.6K tokens × 0.10 ≈ 2.4K unidades; el sobrecosto único (~30K) tarda ~12 requests en amortizarse. **Veredicto provisional: no demuestra valor con caché caliente; solo podría ayudar con caché frío.** Muestra mínima (n=1 por rama, las ramas no hicieron igual número de requests): no es concluyente. Se deja apagado.
- **Reanudación con caché frío, mismos requests reproducidos (2026-10-28, 1 sesión, 6 turnos, unidades normalizadas):**
  - *Escenario 1, un solo turno largo de agente (74K tokens):* compaction no actúa (no hay límite de turno donde cortar; `pickCompactionCutoff` devuelve -1). Context editing solo: **−27.9 %** (turno 1: 24.8K contra 35.5K; ~850 menos por turno posterior).
  - *Escenario 2, 9 turnos humanos con los mismos resultados de herramientas:* compaction solo, compaction + context editing y context editing solo cuestan lo mismo entre sí (~30.3K en 6 turnos; −33 % a −42 % contra el control, cuyo costo varió entre corridas). **Compaction + context editing no mejora a compaction solo:** tras compactar el contexto baja a ~23K tokens, por debajo del umbral de 60K, y el context editing no se dispara (`cleared 0`). Context editing solo es más barato en el turno 1 (19.4K contra 25.1K, no paga a Haiku) pero más caro por turno (2.2K contra 1.1K); se cruzan hacia el turno 6.
  - *Calidad (sondeo débil, respuesta cortada a 40 caracteres, n=1):* el control recordó el primer símbolo exportado de `pricing.ts` en el turno 6; compaction, compaction + context editing y context editing solo respondieron UNKNOWN. **Ambos pierden detalle puntual; el ahorro no es gratis.** El sondeo del turno 1 no sirve: el control también falló.
  - *Veredicto:* context editing no aporta encima de compaction. Su único nicho medido es el caso donde compaction no puede cortar (un turno largo de agente) con caché frío.
- **Decisión (2026-10-28): se descarta el context editing y se queda solo el compaction.** Se eliminó la etapa 5 del código (optimizer, server, extension, ajuste `stage5ContextEditing` y sus pruebas); no queda nada apagado. Si algún día se retoma, la evidencia está arriba: −27.9 % solo en un turno largo de agente con caché frío, sin ventaja sobre compaction en el resto, y con pérdida de detalle.

### 3.2 Compactación server-side en vez de la llamada propia a Haiku
- **[Doc: compaction]:** hay compactación *on demand* (header `compact-2026-09-04`, parámetro `compaction`) y *por umbral* (la API compacta dentro del request al alcanzar un trigger). Ambas en beta. El resumen lo escribe Claude en el servidor.
- **Relevancia:** F-04 – la compactación falla en sesiones grandes (HTTP 400, tramo no cabe en Haiku) y F-21 – tope para sesiones muy largas (prefijo de resúmenes crece sin límite) son limitaciones de nuestro summarizer casero. La versión server-side no depende de que el tramo quepa en Haiku.
- **Trade-off:** perdemos control del prompt de resumen (aunque on-demand permite uno propio) y `SummaryStore` (F-07 – resúmenes solo en memoria) deja de ser necesario o cambia de rol.
- **Recomendación:** prototipar como alternativa a la etapa 2 y comparar en el ledger (unidades facturadas por turno, con y sin).
- **Leído en la documentación completa (2026-10-28) [Doc: compaction, compaction-on-demand, compaction-threshold]:**
  - *Por umbral:* header `compact-2026-01-12`, edición `{"type":"compact_20260112"}` dentro de `context_management.edits` (umbral por defecto 150K, mínimo 50K). El bloque `compaction` llega **en la respuesta del asistente** y el cliente debe devolverlo en los requests siguientes; la API ignora todo lo anterior al bloque. Corre dentro del request que alcanza el umbral. Poco apto para un proxy: el cliente (Claude Code) tendría que reenviar un tipo de bloque que no conoce.
  - *Bajo demanda:* header `compact-2026-09-04`, parámetro `"compaction": {"type":"summarize"}` en un request **aparte**; devuelve solo un bloque `compaction` (con `signature`) y `stop_reason: "compaction"`, sin respuesta. Hay que mandar el mismo `system` y `tools`. Luego el bloque va **primero** en `messages` y se quitan los mensajes resumidos (si quedan delante: 400 `compaction_block_misplaced`); un solo bloque por request; se manda tal cual, con firma. `instructions` propio (hasta 16 384 caracteres) reemplaza el prompt por defecto. Para recompactar, se vuelve a enviar `compaction` y el nuevo bloque resume el anterior más lo posterior.
  - *Costo:* la llamada de resumen se factura y cuenta para rate limits como cualquier otra; aparece en `usage.iterations` con tipo `compaction` (el `input_tokens` de nivel superior queda en 0). Reenviar el bloque después no cuesta nada extra. `cache_control` sobre el bloque pone un breakpoint tras el resumen.
  - *Límites:* no se puede mandar `compaction` junto con `context_management` en el mismo request; imágenes y documentos resumidos se pierden; los mensajes `system` intermedios y el effort por mensaje no se conservan; en modelos con thinking preservado hay condiciones sobre los turnos que se mantienen después del bloque (página `compaction-thinking-blocks`, **no leída**).
  - **Decisión (2026-10-28): descartada, sin experimento.** La etapa 2 con Haiku ya cumple la función, la controlamos desde el proxy y la versión server-side no ahorraría tokens (resume con el modelo de la conversación y exige enviar `system` y `tools`); su ventaja sería solo de robustez (F-04, F-21). Se retoma únicamente si la compactación propia falla de forma recurrente.
  - *No documentado / por probar (si se retoma):* si el resumen puede hacerlo un modelo distinto al de la conversación (por ejemplo Haiku para una conversación en Sonnet) y si el bloque resultante vale en el otro modelo; si un request con bloque admite el `context_management` (`clear_thinking`) que ya manda Claude Code; si la cuenta tiene la beta activa (`capabilities.compaction` en la Models API).

### 3.3 Tamaño de definiciones de tools y MCP
- **[Doc: costs]:** las definiciones de MCP ya se difieren por defecto (solo nombres entran al contexto hasta usarlas). Los CLI (`gh`, `aws`, …) son más baratos que un MCP equivalente. `/context` muestra qué ocupa espacio; `/mcp` permite desactivar servidores sin uso.
- **[Doc: caching]:** las definiciones de tools son el **primer nivel** del prefijo; cualquier cambio (incluido `tool_choice`, toggles de web search/citations) invalida todo lo posterior.
- **Para el proxy:** *no* reordenar ni podar tools por turno (rompe el caché). Si se poda, que sea una política **estable por sesión**. Detectar en el ledger los misses cuyo origen sea cambio de tools.
- **Hábito del usuario:** desactivar MCPs que no se usan; preferir CLI.

### 3.4 Salida y razonamiento (thinking / effort / max_tokens)
- **[Doc: effort]:** `output_config.effort` controla cuántos tokens gasta Claude (respuesta, tool calls y thinking) con un solo modelo. Defaults: `medium` en Opus 5.5 y Haiku 5.5; `high` en el resto de modelos con effort.
- **[Doc: extended-thinking]:** `budget_tokens` está deprecado; desde Claude 4.7 `type: "enabled"` devuelve 400. En modelos nuevos se usa `thinking: {type: "adaptive"}` + `effort`. Cambiar `budget_tokens`/effort entre requests **invalida el caché** de mensajes → elegir un valor y mantenerlo durante toda la conversación.
- **[Doc: costs]:** en Opus 5.5, Sonnet 5.5, Haiku 5.5 y Fable el thinking no se puede apagar; la palanca es `/effort`. `MAX_THINKING_TOKENS` solo aplica a modelos con presupuesto fijo.
- **Para el proxy:** bajar `effort` en turnos mecánicos es posible, pero (1) cambiarlo a mitad de conversación puede invalidar caché según el modelo ("model-specific" en la tabla de invalidación) y (2) F-24 – effort `low` junto con el default a Sonnet ya está identificado como pendiente. Solo aplicar con medición de misses.

### 3.5 Higiene de caché (no perderlo por descuido)
Todo de **[Doc: prompt-caching]**; es "ahorro por no desperdiciar":
- Hit requiere prefijo **100 % idéntico**; jerarquía tools → system → messages.
- **Orden estable de claves** en los bloques `tool_use` (Go/Swift lo aleatorizan y rompen el caché). Comprobar que la normalización (etapa 1) no lo altera.
- **No poner el breakpoint en un bloque que cambia** cada request (timestamps, IDs).
- **Ventana de lectura hacia atrás: 20 posiciones** (rachas de `tool_use` o de `tool_result` consecutivos cuentan como una). Si entre escrituras la conversación crece ≥ 20 bloques, hace falta un segundo breakpoint. → Revisar que la etapa 4 (un solo ancla deslizante) no pierda hits en turnos con muchos bloques. **[Hipótesis]**, medir.
- Máximo **4** breakpoints por request; el caché automático usa uno.
- **Mínimos cacheables** varían por modelo (512 a 4 096 tokens). Si se rutea a Haiku 4.5 (4 096) un prompt corto no se cachea, y `cache_creation` y `cache_read` salen en 0. Relevante para la etapa 3.
- Imágenes añadidas/quitadas invalidan tools y system.
- En modelos soportados, añadir un mensaje `{"role":"system"}` a mitad de conversación **preserva** el caché; editar el `system` de nivel superior no.
- **Hallazgo para revisar (multiplicadores):** la documentación indica lectura 0.10x "para la mayoría", pero **0.025x en Fable 5.1/Mythos 5.1 y 0.05x en Opus 5.5/Sonnet 5.5**; escritura 5 min = 1.25x, 1 h = 2x. La regla 3 del repo cita 0.10x/1.25x. **Verificado en `src/proxy/pricing.ts` (`cacheMultipliers`): los multiplicadores se calculan por modelo desde la tabla de precios; 0.10x/1.25x/2x solo son el respaldo si la tabla no trae la tarifa. No hay sesgo por constante fija.** Queda por comprobar que el feed LiteLLM traiga `cacheRead` de Opus/Sonnet 5.5 y Fable 5.1 (si no, esos tokens salen como "unpriced", ya señalado en la UI).
- TTL: 5 min por defecto y se refresca gratis con cada uso; 1 h cuesta 2x en escritura. Coherente con la regla 5 (`cacheTtl`).
- **Auditoría sobre el ledger real de octubre (2026-10-28; 6 057 turnos, 224.4M unidades, gratis: solo lectura del ledger):**
  - *Fallos de caché con el caché supuestamente vivo* (mismo proyecto + mismo modelo, pausa ≤ 270 s, ≥ 8K tokens): **55 de 5 652 turnos (1.0 %)**, 9.1M unidades = 4.1 % del costo. 39 de ellos (7.3M) son de filas anteriores al diagnóstico de prefijo y su causa no se puede recuperar; 12 (1.4M) son reescrituras tras encogerse el contexto (resumen reutilizado o autocompactado del cliente); 1 fue la compactación (esperada); **solo 3 (148K, 0.07 %) tienen el prefijo intacto por ambos lados**.
  - *Ventana de 20 bloques con el ancla única:* sin evidencia de problema (a lo sumo esos 3 casos). **[Hipótesis descartada con datos]**
  - *El proxy no rompe el caché:* ningún fallo del mismo modelo tiene `clientPrefixChange` = none con `sentPrefixChange` cambiado.
  - *Orden de claves y normalización:* `normalizeContent` conserva el orden de claves y solo recorta `text`; no toca `tool_use`. Nada que hacer.
  - *Mínimo cacheable:* en Claude Code el prefijo siempre supera 20K tokens y no hay ninguna fila de Haiku sin lectura ni escritura de caché; la constante `minimumCacheablePrefix` (2048 para Haiku) puede estar desfasada respecto a la documentación (4 096 en Haiku 4.5), pero hoy no tiene efecto.
  - *Cambio de modelo (etapa 3):* solo 34 turnos del mes se enrutaron a Haiku (todos con historial ≥ 50K, 25 con ≥ 150K); frente al baseline cuesta 1.75M contra 5.0M, pero frente al `floor` (mejor caso del cliente) 1.75M contra 1.49M; 9 de 34 salieron más caros que quedarse. Volumen inmaterial (0.8 % del costo); depende de qué baseline se acepte (ver F-03).
  - ***La palanca real es el vencimiento del TTL:*** reescribir tras una pausa de 5 min a 1 h cuesta 4.7 % del costo. Pasar todo a TTL 1 h no sirve (neto −0.1 %); un ping selectivo cada ~4.5 min con tope de ~30 min da **+3.1 %** neto, ya descontando los pings en vano. Detalle y tabla en F-43.

### 3.6 Ruteo a modelo más barato
- **[Doc: costs]:** Sonnet para la mayoría; Opus solo para arquitectura/razonamiento multi-paso; subagentes simples con `model: haiku`.
- **Ya cubierto** por la etapa 3. Riesgo de calidad: F-15 – ruteo a Haiku por regex. Sugerencia: medir tasa de "reintento del usuario tras respuesta Haiku" como señal de mala ruta **[Hipótesis]**.

### 3.7 Batch API (50 %) — **no aplica al flujo interactivo**
- **[Doc: batch]:** −50 % en tokens, la mayoría de lotes termina en < 1 h, se apila con caché.
- Solo útil para trabajo **asíncrono** (evaluaciones, resúmenes nocturnos). Compactar en medio de una sesión interactiva no puede esperar un lote. Descartado para el proxy; anotado por completitud.

### 3.8 Diseño de resultados de herramientas (nuestras tools/MCP propios)
De **[Doc: writing-tools-for-agents]** (Anthropic Engineering):
- Parámetro `response_format` (concise/detailed): en su ejemplo, la versión concisa usó ~1/3 de los tokens (72 vs 206).
- Paginación, filtros, rangos y truncado con **valores por defecto razonables**; herramientas dirigidas (`search_*`) en vez de masivas (`list_*`/`read_*`).
- Consolidar operaciones encadenadas en una sola tool; mensajes de error accionables.
- Claude Code limita las respuestas de tools a 25 000 tokens por defecto.
- Útil si el equipo construye MCP servers; el proxy no puede arreglar un tool que devuelve de más sin tocar su salida (§3.1 lo mitiga después).

---

## 4. Hábitos de uso (sin tocar el proxy) [Doc: costs]

| Hábito | Efecto |
|---|---|
| `/clear` entre tareas no relacionadas (`/rename` antes si hay que volver) | Elimina contexto viejo que se relee en cada mensaje. Es gratis, a diferencia de compactar. |
| `/compact <instrucciones>` o sección "Compact instructions" en CLAUDE.md | Controla qué sobrevive. Compactar un contexto grande es en sí un request grande. |
| CLAUDE.md < ~200 líneas; mover workflows específicos a **skills** | Skills se cargan bajo demanda; CLAUDE.md se paga en cada sesión. |
| Delegar salidas verbosas (tests, logs, docs) a **subagentes** | El ruido queda en su contexto; vuelve solo un resumen. Ojo: sus requests también consumen. |
| **Hooks** que filtran antes de que Claude lea (p. ej. solo líneas FAIL/ERROR de los tests) | De decenas de miles de tokens a cientos, según la documentación. |
| Prompts específicos ("valida el input de `login` en `auth.ts`") | Evita escaneos amplios. |
| Modo plan (Shift+Tab) y `Esc`/`/rewind` temprano | Evita re-trabajo caro por ir en la dirección equivocada. |
| Plugins de inteligencia de código en lenguajes tipados | "Go to definition" en vez de grep + leer varios archivos. |
| Equipos de agentes: modelo Sonnet, equipos pequeños, apagar los que terminaron | ~7x tokens vs. sesión estándar en modo plan. |
| Cuidado con tareas programadas, `/loop`, check-ins de goals y mensajes entre sesiones | Cada disparo en sesión inactiva reenvía el contexto completo (y tras > TTL, con cache miss). |

---

## 5. Medición (condición para afirmar ahorro)

Regla 9 (verificar antes de afirmar): cada técnica nueva debe poder demostrarse con datos.
- Campos de `usage` por respuesta: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` (y `output_tokens_details.thinking_tokens`). Si creation y read son ambos 0, el prompt no se cacheó [Doc].
- `context_management.applied_edits` da tokens limpiados exactos (§3.1). `count_tokens` con context management devuelve `original_input_tokens` vs. `input_tokens` tras limpiar.
- `/usage` de Claude Code (v2.1.251+) muestra una línea "Prompt cache (main)" con % de tokens desde caché, misses y reconstrucciones esperadas; con v2.1.260+ nombra la causa probable del último miss [Doc]. Sirve como contraste independiente de nuestro ledger.
- Comparar siempre en **unidades facturadas** (regla 3); A/B por tramos: mismas sesiones con y sin la técnica, o la técnica activada por mitades de conversación.
- El sesgo conocido de F-03 (baseline sin autocompact propio de Claude Code, TTL desconocido, conteo local ±10 %) aplica a cualquier ahorro nuevo medido contra ese baseline. Las ediciones server-side tienen la ventaja de reportar lo que **realmente** limpiaron.

---

## 6. Recomendación de orden de trabajo

1. ~~Verificar multiplicadores por modelo~~ — hecho: salen de la tabla de precios (ver §3.5).
2. **Context editing (§3.1)**: prototipo hecho y apagado; **siguiente paso: experimento** (activar, sesión larga, comparar cache read/written con y sin) y, si sirve, persistir `cleared_input_tokens` en el ledger. Candidata a mayor palanca, pero el efecto neto sobre el caché no está medido.
3. **Evaluar compactación server-side (§3.2)** como reemplazo de la etapa 2; resolvería F-04 y reduciría F-07/F-21.
4. **Auditar higiene de caché (§3.5)**: orden de claves, ventana de 20 bloques con el ancla única, mínimos por modelo en el ruteo a Haiku.
5. **Effort/thinking (§3.4)** solo después de medir misses por cambio de parámetros.
6. Hábitos (§4): material para la guía de usuario; encaja con la documentación pendiente (F-29), que por la regla 8 va al final.

**Preguntas abiertas** (no resueltas por esta investigación): si `claude` ya envía `context_management` o su propio compactado por defecto; cuánto interfiere el `clear_tool_uses` con el ancla deslizante de la etapa 4; si los betas listados están disponibles en la cuenta/plataforma del cliente (Bedrock/Vertex/Foundry listadas como beta en la doc de context editing, pero no se comprobó cada una).

---

## Fuentes (consultadas 2026-10-28)
- Prompt caching — platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
- Context editing — platform.claude.com/docs/en/docs/build-with-claude/context-editing
- Compaction — platform.claude.com/docs/en/build-with-claude/compaction
- Effort — platform.claude.com/docs/en/build-with-claude/effort
- Extended thinking — platform.claude.com/docs/en/build-with-claude/extended-thinking
- Batch processing — platform.claude.com/docs/en/docs/build-with-claude/batch-processing
- Manage costs (Claude Code) — code.claude.com/docs/en/costs
- Writing tools for agents — anthropic.com/engineering/writing-tools-for-agents
