# Impacto del proxy desde que arrancó core-banking (6 oct → 30 oct 2026)

Es la fuente de las cifras de la diapositiva "Impact & Business Value". Salen del ledger del proxy (`ledger/2026-09.jsonl` y `2026-10.jsonl`), con la misma función `aggregate()` que usa el dashboard.

## Alcance
- **Desde:** 2026-10-06 (primer registro de `core-banking`, 16:58 UTC). **Hasta:** 2026-10-30.
- **Proyectos:** todos los que tienen registros desde esa fecha: `claude-budget-advisor`, `skills-app`, `core-banking` y `vs6_app`.
- **Muestra:** 8,600 peticiones en 24.5 días corridos (18 días con actividad). Un solo usuario.

## Resultados
| Métrica | Valor |
|---|---|
| Tokens crudos (lo que Claude Code habría enviado) | 2,635.0 M |
| Tokens recibidos por Anthropic | 1,804.6 M |
| Quitados por resumen Haiku | 901.1 M |
| Quitados por limpieza de texto | 1.7 M |
| Lecturas de caché sobre lecturas + escrituras | 95.7 % |
| Unidades facturadas | 323.8 M |
| Unidades sin proxy (línea base estimada) | 498.1 M |
| **Ahorro vs. línea base** | **35.0 %** |
| Cota inferior (cliente con caché ideal de 1 h)* | 32.8 % |
| Caso típico (cliente que reusa 97 % de su caché)* | 45.4 % |

\* Solo cuentan las filas que guardan ese dato (las recientes), así que no cubren todo el periodo.

## En dólares (precio de lista de la API; 1 unidad = 1 token de entrada de Sonnet = $3 por millón)
| | Periodo (24.5 días) | Proyectado a 30 días |
|---|---|---|
| Sin proxy (estimado) | $1,494 | ≈ $1,832 |
| Con proxy (facturado) | $971 | ≈ $1,191 |
| **Ahorro** | **$523** | **≈ $641** |
| Tokens que no viajaron en las peticiones | 830 M | ≈ 1,018 M |

La proyección es lineal: multiplica el periodo por 30 / 24.5. Con un solo mes de datos es una estimación, no un promedio observado de varios meses.

## Cómo leerlo (para no equivocarse en la presentación)
- **No es la factura de Enterprise.** El ledger valora todo a precio de lista de API y suma todos los proyectos; la factura de Claude Code del 1–28 oct fue $852 (ver `findings.md`). Son dos fuentes distintas; el 23.5 % de la factura sigue siendo la evidencia que no depende de ningún modelo de cálculo.
- **La línea base es una estimación** de lo que habría costado el mismo trabajo sin proxy. Por eso se da también la cota inferior.
- **El facturado incluye** los pings de keep-alive y el costo de los resúmenes de Haiku, es decir, el ahorro es neto de lo que cuesta el propio proxy.
- **Un solo usuario y un solo mes.** El piloto con varios compañeros (F-49) serviría para confirmarlo.
