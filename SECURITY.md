# VibeNest Security

VibeNest usa autenticación de Supabase, Row Level Security (RLS), políticas de Storage y cabeceras de seguridad de Netlify.

## Controles activos

- Acceso al Data API limitado a usuarios autenticados.
- RLS en las tablas públicas.
- Políticas separadas para perfiles, publicaciones, comentarios, reacciones, encuestas, mensajes, grupos, stories, guardados, reposts, bloqueos y reportes.
- Validación de propiedad de filas con `auth.uid()`.
- Bloqueos aplicados a contenido y mensajería donde corresponde.
- Protección de campos inmutables con triggers.
- Restricciones para impedir auto-seguirse, auto-bloquearse y mensajes a uno mismo.
- Validación de reportes para que tengan exactamente un objetivo.
- Subidas de Storage limitadas por propietario y rutas por usuario.
- Content Security Policy y otras cabeceras de seguridad en Netlify.
- El cliente nunca contiene una service key/secret key.

## Punto pendiente en el panel

Supabase Advisor indica que **Leaked Password Protection** está desactivada. Esa opción es administrada por Supabase Auth y debe habilitarse desde la configuración de Auth del proyecto.

## Límites conocidos

El bucket `media` existente conserva su carácter público porque la aplicación actual guarda URLs públicas para multimedia. La siguiente fase de seguridad puede migrar multimedia sensible a un bucket privado y servirla mediante URLs firmadas.
