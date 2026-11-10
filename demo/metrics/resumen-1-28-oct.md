# Métricas del ledger, 1–28 oct 2026

Fuente: `demo/data/summary.json` y `daily-breakdown.csv` (exportados con `tools/export_demo_data.py --from 2026-10-01 --to 2026-10-28`, repos `core-banking` y `claude-budget-advisor`).
9,319 turnos en el periodo; 8,949 con respuesta de Anthropic (los únicos con línea base para comparar). Unidades = tokens × peso del modelo (entrada de Sonnet = 1).

## Total
| Métrica | Valor |
|---|---|
| Tokens crudos (lo que Claude Code habría enviado) | 2,855.8 M |
| Tokens recibidos por Anthropic | 2,056.5 M |
| Quitados por resumen Haiku | 833.9 M (29.2 % del crudo) |
| Quitados por limpieza | 1.8 M (0.06 %) |
| Lecturas de caché sobre lecturas + escrituras | 96.0 % |
| Unidades facturadas | 359.5 M |
| Línea base sin proxy (caché del cliente modelado) | 529.0 M → **32.1 %** menos |
| Cota inferior (cliente con caché ideal de 1 h) | 486.2 M → **26.1 %** menos |
| Caso típico | 532.4 M → 32.5 % menos |
| Cambios de modelo | 40 de 8,949 (0.4 %) |
| Resúmenes Haiku | 85 (costo 5.0 M unidades) |

## Por repo (vs línea base / vs cota inferior)
| Repo | Turnos | Ahorro | Cota inferior |
|---|---|---|---|
| claude-budget-advisor | 3,769 | 44.1 % | 38.4 % |
| core-banking | 5,180 | 24.7 % | 18.7 % |

## Cómo leerlo
- La cifra con base en la **factura real** (23.5 % menos que Chen y Steve, ver `findings.md`) es la más sólida: no depende de ningún modelo de cálculo.
- Las del ledger comparan contra una **estimación** del mismo turno sin proxy. La cota inferior (26.1 %) es la que conviene citar: supone un cliente con caché perfecto.
- El mes completo (32 %) coincide mejor con la factura que el periodo 15–28 oct (42 %), que era el tramo más favorable.
- Casi todo el ahorro viene del **resumen Haiku**. La limpieza (0.06 %) y el ruteo de modelo (0.4 %) casi no aportan.

## Advertencias para defender el número
- **Días negativos**: 12 y 14 oct (−6.6 % y −9.4 %) y 13 oct casi cero (2.3 %). Son versiones tempranas del proxy y escrituras de caché en frío. Presentar ahorro neto del mes, no por día.
- **Hueco**: no hay turnos del 15 al 18 oct en el ledger.
- **Antes del 21 oct** la cota inferior es igual a la línea base (no se guardaba aún el dato que las distingue), así que ese tramo no tiene cota inferior independiente.
- Un solo usuario y un solo mes; los datos son locales a esta máquina.
