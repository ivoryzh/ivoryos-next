'use strict';
// The Hub's Supabase project. The anon key is public by design (it ships in the Hub's own web
// page); what a signed-in user may read or write is decided by row-level security. Its own file,
// free of Node modules, so the frontend's tour (frontend/src/tour/) reads the same Hub as the app.
const HUB_AUTH = {
    url: 'https://eaarfpxmxyhxndlsvgkd.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhYXJmcHhteHloeG5kbHN2Z2tkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM0MzcwMDEsImV4cCI6MjA3OTAxMzAwMX0.eSD7GpJ5boAxj5z0KaKoehILMUPbzuJBq7ZosJnfMsI',
};

module.exports = { HUB_AUTH };
