import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
        let autoRole = (String(loginId).toLowerCase() === 'superadmin') ? 'Super Admin' : 'User';
        const { data: newUser, error: insertErr } = await supabase.from('users').insert([{
          sheet_name: loginId, username: loginId, nama: loginId, password: password, role: autoRole, jabatan: '' 
        }]).select().single();
        if (insertErr) return res.json({ error: "ID Pengguna tidak ditemukan atau Kode Akses salah." });
        user = newUser;
      }
      return res.json({ ok: true, message: "Login berhasil", sheetName: user.sheet_name });
    }

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
          let displayName = u.nama || u.username || u.sheet_name;
          
          if (isSuperAdmin || isSekretaris) {
            bawahanList.push({ sheet: u.sheet_name, name: displayName, role: u.role, unit: u.unit_kerja });
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
                bawahanList.push({ sheet: u.sheet_name, name: displayName, role: u.role, unit: u.unit_kerja });
            }
          }
        }
      }
      return res.json({ ok: true, bawahan: bawahanList, role: isSuperAdmin ? 'Super Admin' : ((isSekretaris || isKasubbag) ? 'Admin' : 'User') });
    }

    if (action === 'cekStatusLhk') {
        const { listBawahanSheets } = payload;
        if (!listBawahanSheets || listBawahanSheets.length === 0) return res.json({ ok: true, data: {} });
        
        const { data: usersData } = await supabase.from('users').select('sheet_name, status_upload').in('sheet_name', listBawahanSheets);
        
        let statusMap = {};
        if (usersData) { usersData.forEach(u => { statusMap[u.sheet_name] = u.status_upload; }); }
        return res.json({ ok: true, data: statusMap });
    }

    if (action === 'updateStatusUpload') {
        const { isUploaded } = payload;
        await supabase.from('users').update({ status_upload: isUploaded }).eq('sheet_name', targetSheet);
        return res.json({ ok: true });
    }

    if (action === 'initial') {
      const { data: user } = await supabase.from('users').select('*').eq('sheet_name', targetSheet).single();
      const { data: dbRows } = await supabase.from('lhk_data').select('*').eq('sheet_name', targetSheet).order('sort_order', { ascending: true });
      
      const profile = {
        nama: user?.nama || '', nip: user?.nip || '', jabatan: user?.jabatan || '', unitKerja: user?.unit_kerja || '',
        bulanLaporan: user?.bulan_laporan || 'Oktober 2026', username: user?.username || targetSheet,
        atasanTitle: user?.atasan_title || '', atasanName: user?.atasan_name || '', atasanNip: user?.atasan_nip || '',
        ttdBase64: user?.ttd_base64 || '', ttdAtasanBase64: user?.ttd_atasan_base64 || '', status_upload: user?.status_upload || false
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
        nama: profile.nama, nip: profile.nip, jabatan: profile.jabatan,
        atasan_title: profile.atasanTitle, atasan_name: profile.atasanName,
        atasan_nip: profile.atasanNip, username: profile.username || targetSheet, 
        unit_kerja: unitKerjaBaru, bulan_laporan: profile.bulanLaporan
      };
      
      if (profile.password) updateData.password = profile.password;
      if (ttdBase64 !== undefined) updateData.ttd_base64 = ttdBase64;
      if (ttdAtasanBase64 !== undefined) updateData.ttd_atasan_base64 = ttdAtasanBase64;

      const { data: currUser } = await supabase.from('users').select('role').eq('sheet_name', targetSheet).single();
      if (currUser && currUser.role !== 'Super Admin') {
        const j = String(profile.jabatan || '').toLowerCase();
        const un = String(profile.username || '').toLowerCase();
        if (un === 'superadmin') updateData.role = 'Super Admin';
        else updateData.role = (j.includes('sekretaris') || j.includes('kasubbag')) ? 'Admin' : 'User';
      }

      await supabase.from('users').update(updateData).eq('sheet_name', targetSheet);
      return res.json({ ok: true });
    }

    if (action === 'syncRows') {
      const { rows, isGenerateReset } = payload;
      
      // Hapus bersih seluruh baris lama milik targetSheet di Supabase agar tidak menumpuk/spam
      const { error: delErr } = await supabase.from('lhk_data').delete().eq('sheet_name', targetSheet);
      if (delErr) throw new Error("Gagal membersihkan data lama: " + delErr.message);

      // Jika ini adalah Generate Bulan baru, reset juga status upload GDrive menjadi false
      if (isGenerateReset) {
        await supabase.from('users').update({ status_upload: false }).eq('sheet_name', targetSheet);
      }

      if (rows && rows.length > 0) {
        // Pastikan nomor urut induk terhitung ulang dari 1 secara berurutan
        let parentNoCounter = 1;
        const insertData = rows.map((r, i) => {
          const isParent = Boolean((r.nomor && String(r.nomor).trim() !== '') || (r.tanggal && String(r.tanggal).trim() !== ''));
          return {
            sheet_name: targetSheet,
            nomor: isParent ? String(parentNoCounter++) : '',
            tanggal: r.tanggal || '',
            pukul: r.pukul || '',
            uraian: r.uraian || '',
            jumlah: r.jumlah || '',
            link: r.link || '',
            keterangan: r.keterangan || '',
            sort_order: i + 1
          };
        });
        const { error: insErr } = await supabase.from('lhk_data').insert(insertData);
        if (insErr) throw new Error("Gagal menyimpan baris baru: " + insErr.message);
      }
      return res.json({ ok: true });
    }

    return res.json({ error: "Aksi tidak dikenali." });
  } catch (err) { return res.status(500).json({ error: err.message || String(err) }); }
}
