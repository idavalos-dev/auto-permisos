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

test('en pausa no aprueba nada', async ($, on) => {
  preparar(on, { pausado: true })

  const npm = await $.classic.PermissionRequest(pedir('Bash', { command: 'npm install' }))
  expect(npm.decision).toBeUndefined()
})
