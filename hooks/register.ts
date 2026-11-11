import type { EngineInterface, Register } from 'claude-code'

// ---------------------------------------------------------------------------
// auto-permisos
// Cada vez que Claude va a mostrar el cartel "¿Permitir?", este plugin decide:
//   - si es algo común, lo aprueba solo (el cartel no aparece);
//   - si coincide con una regla de "peligrosos", deja el cartel normal.
// Se maneja con el comando /auto-permisos (ver AYUDA más abajo).
// ---------------------------------------------------------------------------

// Reglas por defecto: comandos que borran, pierden trabajo o tocan el sistema.
// Cada una es una expresión regular (sin distinguir mayúsculas).
const REGLAS_POR_DEFECTO: string[] = [
  '\\brm\\s+-[a-z]*r',
  '\\brm\\s+-[a-z]*f',
  'Remove-Item[^|;]*-Recurse',
  '\\b(rd|rmdir)\\s+/s',
  '\\bdel\\s+/[sqf]',
  '\\bformat\\s+[a-z]:',
  'Format-Volume',
  'Clear-Disk',
  'diskpart',
  'cipher\\s+/w',
  'git\\s+push[^|;]*(--force|\\s-f\\b)',
  'git\\s+reset\\s+--hard',
  'git\\s+clean\\s+-[a-z]*f',
  'git\\s+branch\\s+-D',
  'git\\s+checkout\\s+--\\s',
  'git\\s+restore\\b',
  '\\bshutdown\\b',
  'Stop-Computer',
  'Restart-Computer',
  '\\breg\\s+(delete|add)\\b',
  'Remove-ItemProperty',
  'Set-ExecutionPolicy',
  '\\bbcdedit\\b',
  '\\bvssadmin\\b',
  '\\btakeown\\b',
  '\\bicacls\\b',
  'Stop-Process',
  '\\btaskkill\\b',
  '\\bsudo\\b',
  '\\bmkfs\\b',
  '\\bdd\\s+if=',
]

// Herramientas que son preguntas para vos, no permisos: nunca se aprueban solas.
const SIEMPRE_PREGUNTAR = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']

// Protección fija: que Claude no pueda cambiar su propia configuración ni este plugin.
const CONFIG_DE_CLAUDE = /[\\/]\.claude[\\/](settings[^\\/]*\.json|plugins[\\/])/i
const ESTE_PLUGIN = /auto-permisos/i

type Entrada = { hora: string; resultado: 'PERMITIDO' | 'PREGUNTA'; herramienta: string; detalle: string }
type Chat = { id: string; carpeta: string; desde: string }

const AYUDA = [
  'Uso de /auto-permisos:',
  '  /auto-permisos                 estado actual (y si está activo en este chat)',
  '  /auto-permisos aca             usarlo en este chat',
  '  /auto-permisos no-aca          no usarlo en este chat',
  '  /auto-permisos carpeta         usarlo en todos los chats de la carpeta de este chat',
  '  /auto-permisos no-carpeta [N]  sacar esta carpeta (o la N de la lista de lugares)',
  '  /auto-permisos modo todos      usarlo en todos los chats (salvo los apagados)',
  '  /auto-permisos modo elegidos   usarlo solo en los chats y carpetas elegidos',
  '  /auto-permisos lugares         dónde está prendido y dónde apagado',
  '  /auto-permisos pausar          deja de aprobar en todos lados (Claude pregunta todo)',
  '  /auto-permisos reanudar        vuelve a aprobar',
  '  /auto-permisos reglas          lista los comandos que te sigue preguntando',
  '  /auto-permisos quitar 3        deja de preguntar la regla número 3',
  '  /auto-permisos agregar <regla> agrega una regla (ej: npm\\s+publish)',
  '  /auto-permisos todo            borra todas las reglas: aprueba todo',
  '  /auto-permisos restaurar       vuelve a las reglas de fábrica',
  '  /auto-permisos registro        últimas 20 decisiones',
].join('\n')

function hora(): string {
  const d = new Date()
  const dos = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function coincide(regla: string, cosa: string): boolean {
  try {
    return new RegExp(regla, 'i').test(cosa)
  } catch {
    return false // una regla mal escrita no rompe nada
  }
}

async function leerReglas($: EngineInterface): Promise<string[]> {
  const guardadas = await $.store.get('reglas')
  return Array.isArray(guardadas) ? guardadas.filter((r): r is string => typeof r === 'string') : REGLAS_POR_DEFECTO
}

// --- Reglas "ask" del proyecto ----------------------------------------------
// Si el proyecto pidió en su .claude/settings.json que Claude pregunte algo
// (permissions.ask), el plugin lo respeta y deja el cartel.
const SHELLS = ['Bash', 'PowerShell']

function reglaAskCoincide(regla: string, herramienta: string, comando: string): boolean {
  const m = /^([^(]+)(?:\((.*)\))?$/.exec(regla.trim())
  if (!m) return false
  const nombre = (m[1] ?? '').trim()
  const contenido = m[2]
  const mismaHerramienta = nombre === herramienta || (SHELLS.includes(nombre) && SHELLS.includes(herramienta))
  if (!mismaHerramienta) return false
  if (contenido === undefined || contenido.trim() === '' || contenido.trim() === '*') return true
  if (SHELLS.includes(herramienta)) {
    const prefijo = contenido.replace(/:\*$/, '').replace(/\s*\*$/, '').trim().toLowerCase()
    return prefijo === '' || comando.toLowerCase().includes(prefijo)
  }
  return true // otra herramienta con detalle: ante la duda, preguntar
}

async function reglasAskDelProyecto($: EngineInterface, cwd: string): Promise<string[]> {
  const reglas: string[] = []
  const base = cwd.replace(/[\\/]+$/, '')
  for (const nombre of ['settings.json', 'settings.local.json']) {
    try {
      const datos = JSON.parse(String(await $.fs.read(`${base}/.claude/${nombre}`)))
      const ask = datos?.permissions?.ask
      if (Array.isArray(ask)) reglas.push(...ask.filter((x: unknown): x is string => typeof x === 'string'))
    } catch {
      // el archivo no existe o no se puede leer: no hay reglas de ese archivo
    }
  }
  return reglas
}

// --- En qué chats funciona ---------------------------------------------------
// modo "todos" (de fábrica): en todos los chats, salvo los apagados con "no-aca".
// modo "elegidos": solo en los chats prendidos con "aca" y en las carpetas elegidas.
async function lista<T>($: EngineInterface, clave: string): Promise<T[]> {
  const v = await $.store.get(clave)
  return Array.isArray(v) ? (v as T[]) : []
}

function normalizar(ruta: string): string {
  return ruta.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function dentroDe(cwd: string, carpeta: string): boolean {
  const a = normalizar(cwd)
  const b = normalizar(carpeta)
  return b !== '' && (a === b || a.startsWith(b + '/'))
}

async function activoAca($: EngineInterface, sesion: string, cwd: string): Promise<{ activo: boolean; motivo: string }> {
  if ((await lista<string>($, 'fuera')).includes(sesion)) return { activo: false, motivo: 'apagado en este chat (/auto-permisos aca lo prende)' }
  if ((await lista<Chat>($, 'chats')).some(c => c.id === sesion)) return { activo: true, motivo: 'prendido en este chat' }
  const carpeta = (await lista<string>($, 'carpetas')).find(c => dentroDe(cwd, c))
  if (carpeta) return { activo: true, motivo: `prendido en la carpeta ${carpeta}` }
  return (await $.store.get('modo')) === 'elegidos'
    ? { activo: false, motivo: 'modo "elegidos" y este chat no está elegido (/auto-permisos aca o carpeta)' }
    : { activo: true, motivo: 'modo "todos los chats"' }
}

async function mostrarEstado($: EngineInterface, sesion: string, cwd: string): Promise<void> {
  if ((await $.store.get('pausado')) === true) return $.ui.status('auto-permisos: en pausa')
  $.ui.status((await activoAca($, sesion, cwd)).activo ? 'auto-permisos: activo' : 'auto-permisos: apagado acá')
}

async function anotar($: EngineInterface, entrada: Entrada): Promise<void> {
  const previo = await $.store.get('registro')
  const anteriores = Array.isArray(previo) ? (previo as Entrada[]) : []
  await $.store.set('registro', [...anteriores, entrada].slice(-100))
}

export const register: Register = on => {

  // --- La decisión de cada permiso -----------------------------------------
  on('classic.PermissionRequest', async ($, e, next) => {
    if ((await $.store.get('pausado')) === true) return next(e)
    if (!(await activoAca($, e.session_id, e.cwd)).activo) return next(e)

    const herramienta = e.tool_name
    const entrada = (e.tool_input ?? {}) as Record<string, unknown>
    const comando = texto(entrada.command)
    const archivo = texto(entrada.file_path) || texto(entrada.notebook_path) || texto(entrada.path)
    let detalle = (comando || archivo).replace(/\s+/g, ' ')
    if (detalle.length > 160) detalle = detalle.slice(0, 160) + '...'
    const preguntar = async () => {
      await anotar($, { hora: hora(), resultado: 'PREGUNTA', herramienta, detalle })
      return next(e)
    }

    // 1) Preguntas para vos y control de pantalla
    if (SIEMPRE_PREGUNTAR.includes(herramienta) || herramienta.startsWith('mcp__computer-use__')) return preguntar()

    // 2) Configuración de Claude o este mismo plugin
    if (CONFIG_DE_CLAUDE.test(archivo) || CONFIG_DE_CLAUDE.test(comando) ||
        ESTE_PLUGIN.test(archivo) || ESTE_PLUGIN.test(comando)) return preguntar()

    // 3) Lo que el proyecto marcó como "preguntar" (permissions.ask)
    for (const regla of await reglasAskDelProyecto($, e.cwd)) {
      if (reglaAskCoincide(regla, herramienta, comando)) return preguntar()
    }

    // 4) Reglas de comandos peligrosos
    if (comando) {
      for (const regla of await leerReglas($)) {
        if (coincide(regla, comando)) return preguntar()
      }
    }

    // 5) Todo lo demás: aprobado
    await anotar($, { hora: hora(), resultado: 'PERMITIDO', herramienta, detalle })
    return { decision: { behavior: 'allow' as const } }
  }).catch(($, e, next) => next(e)) // si algo falla, aparece el cartel normal

  // --- El comando /auto-permisos -------------------------------------------
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-permisos',
      description: 'Ver o cambiar qué permisos se aprueban solos',
      argumentHint: '[aca | no-aca | carpeta | modo todos|elegidos | lugares | pausar | reanudar | reglas | registro]',
      immediate: true,
    })
    await mostrarEstado($, await $.session.id(), await $.session.root())
    return next(e)
  })

  on('command.run', { command: 'auto-permisos' }, async ($, e) => {
    const [crudo = '', ...resto] = e.args.trim().split(/\s+/).filter(Boolean)
    const accion = crudo.toLowerCase().replace(/á/g, 'a')
    const argumento = e.args.trim().slice(crudo.length).trim()
    const deLaPersona = ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
    const cambia = ['pausar', 'reanudar', 'quitar', 'agregar', 'todo', 'restaurar',
      'aca', 'no-aca', 'carpeta', 'no-carpeta', 'modo'].includes(accion)
    if (cambia && !deLaPersona) return { text: 'auto-permisos: solo vos podés cambiar esto, escribiendo el comando.' }

    const sesion = await $.session.id()
    const raiz = await $.session.root()
    const respuesta = await responder($, accion, resto, argumento, sesion, raiz)
    await mostrarEstado($, sesion, raiz)
    return { text: respuesta }
  })
}

async function responder($: EngineInterface, accion: string, resto: string[], argumento: string, sesion: string, raiz: string): Promise<string> {
    const reglas = await leerReglas($)
    const pausado = (await $.store.get('pausado')) === true
    const chats = await lista<Chat>($, 'chats')
    const fuera = await lista<string>($, 'fuera')
    const carpetas = await lista<string>($, 'carpetas')
    const modo = (await $.store.get('modo')) === 'elegidos' ? 'elegidos' : 'todos'

    switch (accion) {
      case '':
      case 'estado': {
        const aca = await activoAca($, sesion, raiz)
        return [
            pausado ? 'auto-permisos: EN PAUSA en todos lados (Claude pregunta todo).'
              : `auto-permisos en este chat: ${aca.activo ? 'ACTIVO' : 'APAGADO'} (${aca.motivo}).`,
            `Modo: ${modo === 'todos' ? 'todos los chats' : 'solo chats y carpetas elegidos'}.`,
            reglas.length === 0
              ? 'Sin reglas: aprueba todo salvo las protecciones fijas.'
              : `${reglas.length} reglas de comandos que te sigue preguntando (/auto-permisos reglas).`,
            '',
            AYUDA,
          ].join('\n')
      }
      case 'aca':
        await $.store.set('fuera', fuera.filter(id => id !== sesion))
        if (!chats.some(c => c.id === sesion)) await $.store.set('chats', [...chats, { id: sesion, carpeta: raiz, desde: hora() }])
        return 'Listo: en este chat los permisos comunes se aprueban solos.'
      case 'no-aca':
        await $.store.set('chats', chats.filter(c => c.id !== sesion))
        if (!fuera.includes(sesion)) await $.store.set('fuera', [...fuera, sesion])
        return 'Listo: en este chat Claude te pregunta todo, como siempre. Para volver: /auto-permisos aca'
      case 'carpeta':
        if (carpetas.some(c => normalizar(c) === normalizar(raiz))) return `La carpeta ${raiz} ya estaba elegida.`
        await $.store.set('carpetas', [...carpetas, raiz])
        return `Listo: todos los chats de ${raiz} (y sus subcarpetas) aprueban solos, salvo los que apagues con /auto-permisos no-aca.`
      case 'no-carpeta': {
        const n = Number(resto[0])
        const sacar = resto[0] === undefined ? carpetas.find(c => normalizar(c) === normalizar(raiz))
          : Number.isInteger(n) && n >= 1 && n <= carpetas.length ? carpetas[n - 1] : undefined
        if (!sacar) return resto[0] === undefined ? `La carpeta ${raiz} no estaba elegida.` : 'Número inválido. Mirá la lista con /auto-permisos lugares.'
        await $.store.set('carpetas', carpetas.filter(c => c !== sacar))
        return `Listo: saqué la carpeta ${sacar}.`
      }
      case 'modo': {
        const nuevo = (resto[0] ?? '').toLowerCase()
        if (nuevo !== 'todos' && nuevo !== 'elegidos') return 'Escribí /auto-permisos modo todos  o  /auto-permisos modo elegidos'
        await $.store.set('modo', nuevo)
        return nuevo === 'todos'
          ? 'Modo "todos": funciona en todos los chats, salvo los que apagaste con no-aca.'
          : 'Modo "elegidos": funciona solo en los chats donde escribiste /auto-permisos aca y en las carpetas elegidas.'
      }
      case 'lugares':
        return [
          `Modo: ${modo === 'todos' ? 'todos los chats' : 'solo chats y carpetas elegidos'}.`,
          'Carpetas elegidas:',
          ...(carpetas.length ? carpetas.map((c, i) => `  ${i + 1}. ${c}`) : ['  (ninguna)']),
          `Chats prendidos a mano: ${chats.length}${chats.length ? '' : ' (ninguno)'}`,
          ...chats.map(c => `  - desde ${c.desde} en ${c.carpeta}${c.id === sesion ? '  <- este chat' : ''}`),
          `Chats apagados a mano: ${fuera.length}${fuera.includes(sesion) ? ' (incluye este)' : ''}`,
        ].join('\n')
      case 'pausar':
        await $.store.set('pausado', true)
        return 'auto-permisos en pausa en todos los chats: Claude vuelve a preguntar todo.'
      case 'reanudar':
        await $.store.set('pausado', false)
        return 'auto-permisos activo de nuevo.'
      case 'reglas':
        return reglas.length === 0
          ? 'No hay reglas: se aprueba todo salvo las protecciones fijas.'
          : 'Comandos que te sigue preguntando:\n' + reglas.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
      case 'quitar': {
        const n = Number(resto[0])
        if (!Number.isInteger(n) || n < 1 || n > reglas.length) return `Número inválido. Mirá la lista con /auto-permisos reglas (1 a ${reglas.length}).`
        const sacada = reglas[n - 1]
        await $.store.set('reglas', reglas.filter((_, i) => i !== n - 1))
        return `Listo: ya no te pregunta por "${sacada}".`
      }
      case 'agregar': {
        if (!argumento) return 'Escribí la regla, por ejemplo: /auto-permisos agregar npm\\s+publish'
        try { new RegExp(argumento, 'i') } catch { return `La regla "${argumento}" está mal escrita.` }
        await $.store.set('reglas', [...reglas, argumento])
        return `Listo: te va a preguntar por "${argumento}".`
      }
      case 'todo':
        await $.store.set('reglas', [])
        return 'Listo: aprueba todo. Solo te sigue preguntando cambios a la configuración de Claude, preguntas de Claude, planes y control de pantalla. Para volver atrás: /auto-permisos restaurar'
      case 'restaurar':
        await $.store.set('reglas', REGLAS_POR_DEFECTO)
        return `Reglas de fábrica restauradas (${REGLAS_POR_DEFECTO.length}).`
      case 'registro': {
        const previo = await $.store.get('registro')
        const ultimas = (Array.isArray(previo) ? (previo as Entrada[]) : []).slice(-20)
        return ultimas.length === 0
          ? 'Todavía no hay decisiones registradas.'
          : ultimas.map(x => `${x.hora}  ${x.resultado.padEnd(9)} ${x.herramienta}  ${x.detalle}`).join('\n')
      }
      default:
        return AYUDA
    }
}
