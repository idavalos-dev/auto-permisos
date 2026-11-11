import { expect, test } from 'claude-code/testing'

const pedir = (tool_name: string, tool_input: Record<string, unknown>) => ({
  tool_name,
  tool_input,
  session_id: 's',
  transcript_path: '/t',
  cwd: '/',
})

// El "disco" del plugin, en memoria para la prueba, y debajo el cartel normal (sin decisión)
const preparar = (on: any, inicial: Record<string, unknown> = {}) => {
  const datos: Record<string, unknown> = { ...inicial }
  on('store.get', (_: unknown, e: { key: string }) => ({ value: datos[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    datos[e.key] = e.value
    return { value: undefined }
  })
  on('classic.PermissionRequest', () => ({}))
}

test('aprueba lo común y deja preguntar lo peligroso', async ($, on) => {
  preparar(on)

  const npm = await $.classic.PermissionRequest(pedir('Bash', { command: 'npm install' }))
  expect(npm.decision?.behavior).toBe('allow')

  const edit = await $.classic.PermissionRequest(pedir('Edit', { file_path: 'C:\\proyecto\\x.py' }))
  expect(edit.decision?.behavior).toBe('allow')

  const borrar = await $.classic.PermissionRequest(pedir('PowerShell', { command: 'Remove-Item -Recurse -Force C:\\algo' }))
  expect(borrar.decision).toBeUndefined()

  const force = await $.classic.PermissionRequest(pedir('Bash', { command: 'git push --force origin main' }))
  expect(force.decision).toBeUndefined()

  const config = await $.classic.PermissionRequest(pedir('Write', { file_path: 'C:\\Users\\x\\.claude\\settings.json' }))
  expect(config.decision).toBeUndefined()

  const pregunta = await $.classic.PermissionRequest(pedir('AskUserQuestion', {}))
  expect(pregunta.decision).toBeUndefined()
})

test('sin reglas aprueba todo salvo las protecciones fijas', async ($, on) => {
  preparar(on, { reglas: [] })

  const borrar = await $.classic.PermissionRequest(pedir('PowerShell', { command: 'Remove-Item -Recurse -Force C:\\algo' }))
  expect(borrar.decision?.behavior).toBe('allow')

  const config = await $.classic.PermissionRequest(pedir('Edit', { file_path: '/home/x/.claude/settings.json' }))
  expect(config.decision).toBeUndefined()
})

test('respeta las reglas "ask" del proyecto', async ($, on) => {
  preparar(on, { reglas: [] })
  const settings = JSON.stringify({ permissions: { ask: ['Bash(npm run ajuste:*)', 'Bash(node src/ajuste-masivo-mobile.js:*)'] } })
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.replace(/\\/g, '/').endsWith('/.claude/settings.json')) return { value: settings }
    throw new Error('no existe')
  })

  const ajuste = await $.classic.PermissionRequest(pedir('Bash', { command: 'npm run ajuste -- --todo' }))
  expect(ajuste.decision).toBeUndefined()

  const masivo = await $.classic.PermissionRequest(pedir('PowerShell', { command: 'cd x; node src/ajuste-masivo-mobile.js' }))
  expect(masivo.decision).toBeUndefined()

  const saldos = await $.classic.PermissionRequest(pedir('Bash', { command: 'npm run saldos' }))
  expect(saldos.decision?.behavior).toBe('allow')
})

test('modo elegidos: solo aprueba en chats y carpetas elegidos', async ($, on) => {
  preparar(on, {
    modo: 'elegidos',
    chats: [{ id: 'chat-elegido', carpeta: 'C:\\otra', desde: 'x' }],
    carpetas: ['C:\\Users\\x\\Proyecto'],
    fuera: ['chat-apagado'],
  })
  const en = (session_id: string, cwd: string) => ({ ...pedir('Bash', { command: 'npm install' }), session_id, cwd })

  expect((await $.classic.PermissionRequest(en('chat-elegido', 'D:\\cualquiera'))).decision?.behavior).toBe('allow')
  expect((await $.classic.PermissionRequest(en('chat-nuevo', 'c:/users/x/proyecto/sub'))).decision?.behavior).toBe('allow')
  expect((await $.classic.PermissionRequest(en('chat-nuevo', 'C:\\Users\\x\\ProyectoB'))).decision).toBeUndefined()
  expect((await $.classic.PermissionRequest(en('chat-apagado', 'C:\\Users\\x\\Proyecto'))).decision).toBeUndefined()
})

test('modo todos: aprueba en todos salvo los apagados', async ($, on) => {
  preparar(on, { fuera: ['chat-apagado'] })
  const en = (session_id: string) => ({ ...pedir('Bash', { command: 'npm install' }), session_id })

  expect((await $.classic.PermissionRequest(en('cualquiera'))).decision?.behavior).toBe('allow')
  expect((await $.classic.PermissionRequest(en('chat-apagado'))).decision).toBeUndefined()
})

test('en pausa no aprueba nada', async ($, on) => {
  preparar(on, { pausado: true })

  const npm = await $.classic.PermissionRequest(pedir('Bash', { command: 'npm install' }))
  expect(npm.decision).toBeUndefined()
})
