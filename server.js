require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Client "normal" (clé anon) : utilisé pour les opérations courantes, respecte les
// policies RLS de chaque table.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Client "admin" (clé service_role) : NE JAMAIS exposer côté frontend. Utilisé
// uniquement pour les opérations privilégiées explicites ci-dessous (créer un
// compte utilisateur). Si la variable n'est pas définie, ces routes répondent une
// erreur claire plutôt que de planter.
const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Route de test simple, sans authentification — utile pour vérifier que le service
// est bien démarré sur Render (ouvrir l'URL du backend dans un navigateur doit
// afficher ce message au lieu d'une erreur).
app.get('/', (req, res) => res.json({ statut: 'CHF backend (Supabase) en ligne' }));

// Middleware de vérification du token Supabase Auth envoyé dans l'en-tête
// Authorization: Bearer <token> (remplace l'ancienne vérification Firebase).
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant ou invalide' });
  }
  const token = authHeader.split('Bearer ')[1];
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
  req.user = data.user;
  next();
}

// Application du middleware sur toutes les routes API
app.use('/api', verifyToken);

// Route : récupération de tous les épisodes
app.get('/api/episodes', async (req, res) => {
  const { data, error } = await supabase
    .from('episodes')
    .select('*')
    .order('timestamp', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Route : création d'un épisode
app.post('/api/episodes', async (req, res) => {
  const { data, error } = await supabase
    .from('episodes')
    .insert(req.body)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});

// Route : mise à jour d'un épisode
app.put('/api/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('episodes')
    .update(req.body)
    .eq('id', id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0] || {});
});

// Route : suppression d'un épisode
app.delete('/api/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('episodes').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Route : récupération du catalogue (médicaments ou actes)
app.get('/api/catalog/:type', async (req, res) => {
  const { type } = req.params;
  const { data, error } = await supabase
    .from('catalog')
    .select('items')
    .eq('type', type)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json(data?.items || []);
});

// Route : mise à jour du catalogue
app.put('/api/catalog/:type', async (req, res) => {
  const { type } = req.params;
  const { items } = req.body;
  const { error } = await supabase
    .from('catalog')
    .update({ items, updated_at: new Date().toISOString() })
    .eq('type', type);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Route : récupération des paiements
app.get('/api/paiements', async (req, res) => {
  const { data, error } = await supabase
    .from('paiements')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Route : création d'un paiement
app.post('/api/paiements', async (req, res) => {
  const { data, error } = await supabase
    .from('paiements')
    .insert(req.body)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});

// Route : création d'un utilisateur par un administrateur (remplace
// auth.createUserWithEmailAndPassword de Firebase, qui n'a pas d'équivalent sûr côté
// client avec Supabase — créer un compte via le SDK client déconnecterait
// l'administrateur en le remplaçant par la session du nouveau compte).
// Protégée : seul un appelant dont la ligne dans la table "users" a role =
// 'administrateur' peut l'utiliser.
app.post('/api/admin/users', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquante côté serveur." });
  }
  const { data: profil } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
  if (!profil || profil.role !== 'administrateur') {
    return res.status(403).json({ error: "Réservé aux administrateurs." });
  }
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis.' });
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true
  });
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ uid: data.user.id });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend CHF demarré sur le port ${PORT}`);
});
