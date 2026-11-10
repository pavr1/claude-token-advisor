"""Fill the showcase template from the content in borrador.md.

Usage: python demo/slides/build_deck.py
Reads  AI_Uncovered_Showcase_Template.pptx and how-it-works-slide.png (same folder).
Writes Claude_Budget_Advisor_Showcase.pptx. The template is never modified.

Text still in [brackets] is for the presenter to fill in; it is left visible on purpose.
"""
import copy, os
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor

HERE = os.path.dirname(os.path.abspath(__file__))
prs = Presentation(os.path.join(HERE, 'AI_Uncovered_Showcase_Template.pptx'))
slides = list(prs.slides)


def shape(slide, shape_id):
    for sh in slide.shapes:
        if sh.shape_id == shape_id:
            return sh
    raise KeyError(f'shape {shape_id} not on slide')


def set_text(slide, shape_id, *texts):
    """Replace the text, keeping each paragraph's first run (its font, size and colour)."""
    tf = shape(slide, shape_id).text_frame
    while len(tf.paragraphs) < len(texts):
        tf._txBody.append(copy.deepcopy(tf.paragraphs[-1]._p))
    for para, text in zip(tf.paragraphs, texts):
        runs = para.runs
        run = runs[0] if runs else para.add_run()
        run.text = text
        for extra in runs[1:]:
            extra._r.getparent().remove(extra._r)
    for para in tf.paragraphs[len(texts):]:
        para._p.getparent().remove(para._p)


def delete(slide, *shape_ids):
    for sid in shape_ids:
        el = shape(slide, sid)._element
        el.getparent().remove(el)


def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text


# 1 Cover
s = slides[0]
set_text(s, 36, '[ARENA] · 5 Nov 2026')
set_text(s, 37, 'Claude Budget Advisor & Token Improver')
set_text(s, 38, 'Pablo Villalobos')
set_text(s, 39, 'Talent')

# 3 Agenda: a short description per item, no times, no total-minutes box
s = slides[2]
set_text(s, 79, 'How can I lower token consumption?')
set_text(s, 85, 'Local proxy that improves requests before sending them to Anthropic')
set_text(s, 91, 'Intercepts each request and runs it through several improvement steps')
set_text(s, 97, 'The saving and one real request, live')
set_text(s, 103, 'About 35 % less token spend, measured in our own ledger')
# the options reach the right-hand margin the other slides use (11,640,312 EMU)
for sid in (75, 81, 87, 93, 99):
    shape(s, sid).width = Emu(11_640_312 - shape(s, sid).left)
for sid in (79, 85, 91, 97, 103):
    shape(s, sid).width = Emu(11_640_312 - 182_880 - shape(s, sid).left)
delete(s, 80, 86, 92, 98, 104, 105, 106, 107, 108, 109, 110)

# 4 Team: a single card, centred (the middle card of the template, moved to the exact centre)
s = slides[3]
delete(s, 119, 120, 121, 122, 123, 124, 131, 132, 133, 134, 135, 136)
for sid in (125, 126, 127, 128, 129, 130):
    shape(s, sid).left = Emu(shape(s, sid).left + 38_100)
set_text(s, 128, 'Pablo Villalobos')
set_text(s, 129, 'Talent')
set_text(s, 130, 'Built the proxy and the dashboard, and measured the savings.')

# 6 Challenge
s = slides[5]
set_text(s, 152, 'How can I lower token consumption?')
set_text(s, 160, 'Personal case: I struggled to keep up with my tokens and used up my $200 monthly Enterprise budget in one week.')
set_text(s, 161, '1 week', 'to use up the $200 monthly Enterprise budget')
set_text(s, 166, 'Just open Claude and select the Sonnet agent')
set_text(s, 170, 'No best practices applied to save tokens')
delete(s, 171, 172, 173, 174)  # not much else to say about the old process
notes(s, 'Caso personal: se acabo el presupuesto mensual Enterprise de $200 en una semana. Proceso anterior: abrir Claude, elegir Sonnet y trabajar, sin buenas practicas de ahorro. Pregunta que abre la presentacion: como puedo bajar el consumo de tokens?')

# 8 AI Solution
s = slides[7]
set_text(s, 190, 'Local proxy that improves requests before sending to Anthropic')
set_text(s, 197, 'A VS Code extension with a local proxy. Claude Code is pointed at it; the proxy optimizes each request before it reaches Anthropic and records what it really cost.')
set_text(s, 199, 'Steps 0–1: default model (Opus to Sonnet) and text clean-up')
set_text(s, 201, 'Steps 2–3: Haiku summary of old history and model routing')
set_text(s, 203, 'Step 4: cache anchor, plus a keep-alive to keep the cache warm')
set_text(s, 209, 'Claude Code')
set_text(s, 211, 'Claude Sonnet and Haiku')
set_text(s, 213, 'Anthropic API')
set_text(s, 214, '[Confirm: approved by the GAP Security Team]')
notes(s, 'PENDIENTE: confirmar que Claude Code esta aprobado por GAP. Si no, quitar la linea de aprobacion. Seguridad: el proxy escucha solo en 127.0.0.1; las credenciales se reenvian tal cual y el keep-alive las guarda solo en memoria (verificar antes de afirmarlo).')

# 10 How it works: back to the template (Before / AI intervention / After, human role, where AI adds value)
s = slides[9]
set_text(s, 238, 'Without the proxy: whole history, text as typed and no cache care on every request.')
set_text(s, 244, 'Intercepts each request and applies five steps, from clean-up to cache anchor.')
set_text(s, 250, 'Same Claude Code, new way of working: smaller, cheaper requests and every cost measured.')
set_text(s, 255, 'The process is automatic and needs no approval. We configure it once and review the results in the dashboard.')
set_text(s, 260, 'Token savings: we have enough data to estimate the saving as a percentage.')
notes(s, 'Antes: como funciona sin proxy. Intervencion: donde y como actua el proxy (pasos 0 a 4). Despues: nueva forma de trabajar. Rol humano: nada que aprobar, se configura una vez y se revisa el dashboard. Valor: ahorro en consumo de tokens. El diagrama de ida y vuelta esta en demo/slides/how-it-works.png por si se quiere usar como apoyo.')

# 12 Demo
s = slides[11]
set_text(s, 276, 'Claude Budget Advisor in action')
set_text(s, 282, 'LIVE DEMO · shown from the tool itself')
set_text(s, 287, 'The saving headline and the status bar')
set_text(s, 291, 'One real request, live: from Raw to Billed')
set_text(s, 295, 'Hover a number: the formula behind it')
notes(s, 'Guion para grabar el video en demo/video/script.md. Guion de la demo en vivo en demo/script/guion-demo.md.')

# 14 Impact: money and tokens saved, from the ledger since core-banking started (Oct 6) for every project
s = slides[13]
set_text(s, 311, 'About 35 % less token spend')
set_text(s, 318, '35 %')
set_text(s, 319, 'less spend than without the proxy (estimated)')
set_text(s, 323, '~$640')
set_text(s, 324, 'saved per month (estimated)')
set_text(s, 328, '~1B')
set_text(s, 329, 'tokens kept out of requests per month')
set_text(s, 332, '~$1,830 per month without the proxy (estimated)')
set_text(s, 335, '~$1,190 per month with the proxy (billed)')
source = s.shapes.add_textbox(Emu(548640), Emu(5_960_000), Emu(10_500_000), Emu(300_000))
source.text_frame.text = 'Source: proxy ledger, Oct 6–30 2026, every project since core-banking started. API list prices; savings are an estimate against the same requests without the proxy.'
for r in source.text_frame.paragraphs[0].runs:
    r.font.size = Pt(11)
    r.font.color.rgb = RGBColor(0x6B, 0x77, 0x82)
notes(s, 'Datos: ledger del proxy desde el 6 oct (inicio de core-banking) hasta el 30 oct, todos los proyectos: 8,600 peticiones en 24.5 dias. Ahorro 35.0 % vs linea base estimada (cota inferior 32.8 % en las filas que la tienen). Facturado $971 vs $1,494 sin proxy = $523; proyectado a 30 dias: $1,191 vs $1,832, ahorro ~$641. Son precios de lista de API, no la factura Enterprise. Detalle en demo/metrics/impacto-desde-core-banking.md.')

# 15 Takeaways
s = slides[14]
set_text(s, 348, 'Cache is the lever')
set_text(s, 349, '• Anthropic caches the prompt for 5 min, or 1 h', '• A read costs 0.1×, a write 1.25× (2× for 1 h)', '• An expired cache means paying the write again')
set_text(s, 353, 'Tokens are not units')
set_text(s, 354, '• Each model has its own weight (Sonnet input = 1)', '• Units = tokens × that weight', '• Compare cost in units, not in tokens')
set_text(s, 358, 'What the proxy does')
set_text(s, 359, '• Text clean-up', '• Haiku summary of old history', '• Model routing', '• Cache anchor and keep-alive')

# 16 Roadmap (proposals: the presenter decides)
s = slides[15]
set_text(s, 373, 'Working extension: local proxy, live dashboard and a per-request ledger, used on real projects.')
set_text(s, 378, '• Pilot with several peers to get feedback', '• Tips section in the dashboard to save tokens', '• Close the pending items of the findings list')
set_text(s, 383, 'One cloud server where every local proxy reports, to track consumption and savings at company level.')
notes(s, 'Ahora: extension funcional. Siguiente: piloto con varios companeros, seccion de tips y pendientes de findings. Largo plazo: servidor en la nube que consolide los datos de cada proxy local (F-48, F-49 y F-50 en latest/findings.md).')

# 18 Thank you
s = slides[17]
set_text(s, 400, '[Presenter name]')
set_text(s, 401, '[email]@growthaccelerationpartners.com')

# 2 Instructions: not for the audience
sld = prs.slides._sldIdLst
first = list(sld)[1]
prs.part.drop_rel(first.rId)
sld.remove(first)

out = os.path.join(HERE, 'Claude_Budget_Advisor_Showcase.pptx')
prs.save(out)
print('saved', out, len(prs.slides), 'slides')
