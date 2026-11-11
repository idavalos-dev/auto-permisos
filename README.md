# auto-permisos

Plugin para Claude Code que aprueba solos los permisos comunes y te sigue
preguntando solo los comandos peligrosos.

## Qué hace

Cada vez que Claude va a mostrar el cartel "¿Permitir?", el plugin decide:

1. **Siempre te pregunta** (no se puede cambiar):
   - preguntas de Claude, aprobación de planes y control de pantalla;
   - cambios a la configuración de Claude (`settings.json`, plugins) o a este plugin.
2. **Respeta lo que el proyecto pide preguntar**: si el `.claude/settings.json`
   (o `settings.local.json`) del proyecto tiene reglas en `permissions.ask`,
   esos comandos te los sigue preguntando.
3. **Te pregunta si coincide con una regla**: borrar carpetas, `git push --force`,
   `git reset --hard`, apagar la PC, `taskkill`, etc. (31 reglas de fábrica).
4. **Todo lo demás lo aprueba solo** y queda anotado en el registro.

Si algo falla dentro del plugin, aparece el cartel normal: nunca aprueba por error.

## Cómo se maneja

Todo desde el chat con el comando `/auto-permisos`:

| Comando | Qué hace |
| --- | --- |
| `/auto-permisos` | estado y ayuda |
| `/auto-permisos pausar` / `reanudar` | apaga o prende la aprobación automática |
| `/auto-permisos reglas` | lista numerada de lo que te sigue preguntando |
| `/auto-permisos quitar 3` | deja de preguntar la regla 3 |
| `/auto-permisos agregar npm\s+publish` | agrega una regla nueva |
| `/auto-permisos todo` | borra todas las reglas: aprueba todo (salvo lo fijo) |
| `/auto-permisos restaurar` | vuelve a las reglas de fábrica |
| `/auto-permisos registro` | últimas 20 decisiones |

Los cambios se guardan y valen para todos los chats. Solo los podés hacer vos
escribiendo el comando; Claude no puede cambiarlos por su cuenta.

## Instalación

Desde una carpeta (por ejemplo, si te pasaron esta carpeta comprimida), en una terminal:

```
claude plugin marketplace add "<ruta a esta carpeta>"
claude plugin install auto-permisos@asistente-de-claude
```

Desde GitHub, en una sesión de terminal de Claude Code:

```
/plugin install auto-permisos --marketplace idavalos-dev/auto-permisos
```

o desde una terminal común:

```
claude plugin install auto-permisos --marketplace idavalos-dev/auto-permisos
```

El repositorio es privado: solo funciona para quien tenga acceso en GitHub y
tenga GitHub configurado en su computadora (`gh auth login` y `gh auth setup-git`).

En la app de escritorio: botón **+** junto al cuadro de texto → **Plugins** →
**Add marketplace** → la carpeta o `idavalos-dev/auto-permisos` → **Add plugin**.

### Para un proyecto entero (también sesiones en la nube)

Agregá esto al `.claude/settings.json` del repositorio del proyecto:

```json
{
  "extraKnownMarketplaces": {
    "asistente-de-claude": { "source": { "source": "github", "repo": "idavalos-dev/auto-permisos" } }
  },
  "enabledPlugins": { "auto-permisos@asistente-de-claude": true }
}
```

Después abrí un chat nuevo. Para desinstalar: `claude plugin uninstall auto-permisos`.

Requiere una versión reciente de Claude Code (plugins con módulos de hooks).
