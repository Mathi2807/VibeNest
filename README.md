# VibeNest

VibeNest is a web social network built with plain HTML/CSS/JavaScript, Supabase and Netlify.

## VibeNest 2.0

- 🔐 Email/password authentication with persistent sessions
- 🏠 Home feed with "Para ti" and "Siguiendo"
- 📸 Stories with 24-hour expiration
- 📝 Posts with text, images and videos
- 📊 Polls with up to 6 options
- ❤️ Likes and ✨ emoji reactions
- 💬 Comments with edit/delete
- 🔖 Saved posts
- 🔁 Reposts
- 🔗 Shareable post links
- #️⃣ Hashtags and search
- 🔎 Explore + VibeNest Pulse
- 👤 Profiles with avatar, cover, bio, website and interests
- 👥 Followers/following
- 💬 Private one-to-one messaging with read states
- 👥 Groups with group chat
- 🔔 Notifications
- ⛔ Blocking and 🚩 reporting
- 🏆 Achievements
- 🎨 Light/dark/system themes
- 📱 Responsive mobile navigation
- 🛡️ RLS policies for social data
- ☁️ Supabase Storage for media

## Architecture

The frontend is intentionally dependency-light. It uses a local `supabase-lite.js` client that talks directly to Supabase REST/Auth/Storage APIs, so VibeNest does not depend on an external Supabase JavaScript CDN.

Netlify serves the static site. Supabase provides authentication, PostgreSQL, RLS and Storage.

## Notes

Direct messaging and group chat use short polling in the current lightweight client rather than a browser WebSocket implementation.

Supabase's security advisor currently reports that leaked-password protection is disabled. The rest of the database changes were checked with the Supabase security/performance advisors.

Production: https://vibenestweb.netlify.app
