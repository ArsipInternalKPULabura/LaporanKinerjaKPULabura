import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import stream from 'stream';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/drive'], 
});

const drive = google.drive({ version: 'v3', auth });
const BASE_FOLDER_ID = '1PMha227_Z5yUWW2xnFuOJ_2ktWDIwWvu'; 

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Hanya POST yang diizinkan' });

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { action, loginId, password } = payload;
    const aktorLogin = payload.aktorLogin || loginId;
    const targetSheet = payload.targetSheet || aktorLogin;

    if (action === 'login') {
      let { data: user } = await supabase.from('users')
        .select('*').or(`sheet_name.eq.${loginId},username.eq.${loginId}`).eq('password', password).single();

      if (!user) {
        // Hanya Super Admin yang di-hardcode. Sisanya otomatis dari setting profil.
        let autoRole = (String(loginId).toLowerCase() === 'superadmin') ? 'Super Admin' : 'User';

        const { data: newUser, error: insertErr } = await supabase.from('users').insert([{
          sheet_name: loginId, 
          username: loginId, 
          nama: loginId, 
          password: password, 
          role: autoRole,
          jabatan: '' 
        }]).select().single();

        if (insertErr) return res.json({ error: "Username tidak ditemukan atau Password salah." });
        user = newUser;
      }
      return res.json({ ok: true, message: "Login berhasil", sheetName: user.sheet_name });
    }

    // Mengambil daftar atasan langsung dari Database (Dinamis)
    if (action === 'getAtasanList') {
      const { data: atasan } = await supabase.from('users')
        .select('nama, username, nip, jabatan, ttd_base64')
        .or('jabatan.ilike.%kasubbag%,jabatan.ilike.%sekretaris%');
      return res.json({ ok: true, data: atasan || [] });
    }

    if (action === 'getBawahan') {
      const { data: me } = await supabase.from('users').select('*').eq('sheet_name', aktorLogin).single();
      const { data: allUsers } = await supabase.from('users').select('*');
      
      let bawahanList = [];
      const myRole = me?.role || 'User';
      const myJabatan = (me?.jabatan || '').toLowerCase();
      const myName = (me?.username || '').toLowerCase();

      const isSuperAdmin = (myRole === 'Super Admin' || myName === 'superadmin');
      const isSekretaris = myJabatan.includes('sekretaris');
      const isKasubbag = myJabatan.includes('kasubbag');

      if (isSuperAdmin || isSekretaris || isKasubbag) {
        for (let u of allUsers) {
          if (u.sheet_name === aktorLogin) continue;
          let uUnit = (u.unit_kerja || '').toLowerCase();
          
          if (isSuperAdmin || isSekretaris) {
            bawahanList.push({ sheet: u.sheet_name, name: u.username, role: u.role, unit: u.unit_kerja });
          } else if (isKasubbag) {
            let targetUnit = "";
            if (myJabatan.includes('keuangan') || myJabatan.includes('umum') || myJabatan.includes('logistik')) {
                targetUnit = "subbagian keuangan, umum dan logistik";
            } else if (myJabatan.includes('teknis') || myJabatan.includes('parmas')) {
                targetUnit = "subbagian teknis dan parmas";
            } else if (myJabatan.includes('rendatin')) {
                targetUnit = "subbagian rendatin";
            } else if (myJabatan.includes('hukum') || myJabatan.includes('sdm')) {
                targetUnit = "subbagian hukum dan sdm";
            }

            if (uUnit.includes(targetUnit) || (targetUnit.includes('keuangan') && uUnit.includes('keuangan umum'))) {
                bawahanList.push({ sheet: u.sheet_name, name: u.username, role: u.role, unit: u.unit_kerja });
            }
          }
        }
      }
      return res.json({ ok: true, bawahan: bawahanList, role: isSuperAdmin ? 'Super Admin' : ((isSekretaris || isKasubbag) ? 'Admin' : 'User') });
    }

    if (action === 'initial') {
      const { data: user } = await supabase.from('users').select('*').eq('sheet_name', targetSheet).single();
      const { data: dbRows } = await supabase.from('lhk_data').select('*').eq('sheet_name', targetSheet).order('sort_order', { ascending: true });
      
      const profile = {
        nama: user?.nama || '', nip: user?.nip || '', jabatan: user?.jabatan || '', unitKerja: user?.unit_kerja || '',
        bulanLaporan: user?.bulan_laporan || 'Oktober 2026', username: user?.username || targetSheet,
        atasanTitle: user?.atasan_title || '', atasanName: user?.atasan_name || '', atasanNip: user?.atasan_nip || '',
        ttdBase64: user?.ttd_base64 || '', ttdAtasanBase64: user?.ttd_atasan_base64 || ''
      };
      return res.json({ profile, rows: dbRows || [] });
    }

    if (action === 'saveProfile') {
      const { profile, ttdBase64, ttdAtasanBase64 } = payload;
      
      let unitKerjaBaru = profile.unitKerja;
      if(unitKerjaBaru && unitKerjaBaru.includes("Subbagian Keuangan Umum")) {
         unitKerjaBaru = unitKerjaBaru.replace("Subbagian Keuangan Umum", "Subbagian Keuangan, Umum dan Logistik");
      }

      let updateData = {
        nama: profile.nama, nip: profile.nip, atasan_title: profile.atasanTitle, atasan_name: profile.atasanName,
        atasan_nip: profile.atasanNip, username: profile.username || targetSheet, unit_kerja: unitKerjaBaru, 
        jabatan: profile.jabatan, bulan_laporan: profile.bulanLaporan
      };
      if (profile.password) updateData.password = profile.password;
      if (ttdBase64 !== undefined) updateData.ttd_base64 = ttdBase64;
      if (ttdAtasanBase64 !== undefined) updateData.ttd_atasan_base64 = ttdAtasanBase64;

      const { data: currUser } = await supabase.from('users').select('role').eq('sheet_name', targetSheet).single();
      if (currUser && currUser.role !== 'Super Admin') {
        const j = String(profile.jabatan).toLowerCase();
        const un = String(profile.username).toLowerCase();
        if(un === 'superadmin') updateData.role = 'Super Admin';
        // Otomatis menaikkan Role menjadi Admin jika Jabatannya Kasubbag / Sekretaris
        else updateData.role = (j.includes('sekretaris') || j.includes('kasubbag')) ? 'Admin' : 'User';
      }

      await supabase.from('users').update(updateData).eq('sheet_name', targetSheet);
      return res.json({ ok: true });
    }

    if (action === 'syncRows') {
      const { rows } = payload;
      await supabase.from('lhk_data').delete().eq('sheet_name', targetSheet);
      
      if (rows && rows.length > 0) {
        const insertData = rows.map((r, i) => ({
          sheet_name: targetSheet, nomor: r.nomor || '', tanggal: r.tanggal || '', pukul: r.pukul || '',
          uraian: r.uraian || '', jumlah: r.jumlah || '', link: r.link || '', keterangan: r.keterangan || '', sort_order: i + 1
        }));
        await supabase.from('lhk_data').insert(insertData);
      }
      return res.json({ ok: true });
    }

    if (action === 'simpanPdfKeDrive') {
      const folderName = payload.bulanLaporan || 'Tanpa Bulan';
      let folderId;
      const qFolder = `'${BASE_FOLDER_ID}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const searchRes = await drive.files.list({ q: qFolder, fields: 'files(id)' });
      
      if (searchRes.data.files.length > 0) { folderId = searchRes.data.files[0].id; } 
      else {
        const createRes = await drive.files.create({ requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [BASE_FOLDER_ID] }, fields: 'id' });
        folderId = createRes.data.id;
      }

      const fileName = `LHK_${targetSheet}_${folderName}.pdf`;
      const qOldFile = `'${folderId}' in parents and name = '${fileName}' and trashed = false`;
      const oldFiles = await drive.files.list({ q: qOldFile });
      for (let f of oldFiles.data.files) { await drive.files.update({ fileId: f.id, requestBody: { trashed: true } }); }

      const pdfBuffer = Buffer.from(payload.pdfBase64.split(',')[1], 'base64');
      const bufferStream = new stream.PassThrough(); bufferStream.end(pdfBuffer);
      
      const uploadRes = await drive.files.create({ requestBody: { name: fileName, parents: [folderId] }, media: { mimeType: 'application/pdf', body: bufferStream }, fields: 'webViewLink' });
      return res.json({ ok: true, url: uploadRes.data.webViewLink });
    }

    return res.json({ error: "Aksi tidak dikenali." });

  } catch (err) { return res.status(500).json({ error: err.message || String(err) }); }
}
