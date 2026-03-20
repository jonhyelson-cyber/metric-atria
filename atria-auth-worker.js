export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // --- ROTA DE REGISTRO ---
    if (url.pathname === "/register" && request.method === "POST") {
      try {
        const { nome, email, senha } = await request.json();
        
        // 1. Gera Pixel ID Único
        const pixelId = `AM-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        
        // 2. Hash da Senha (Simples para Worker, usando SHA-256)
        const msgUint8 = new TextEncoder().encode(senha);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
        const senhaHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        // 3. Insere no D1
        await env.DB.prepare(`
          INSERT INTO usuarios (nome, email, senha_hash, pixel_id, plano)
          VALUES (?, ?, ?, ?, 'FREE')
        `).bind(nome, email, senhaHash, pixelId).run();

        return new Response(JSON.stringify({ success: true, pixelId }), { 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Email já cadastrado ou erro no banco." }), { 
          status: 400, headers: corsHeaders 
        });
      }
    }

    // --- ROTA DE LOGIN ---
    if (url.pathname === "/login" && request.method === "POST") {
      const { email, senha } = await request.json();
      
      const msgUint8 = new TextEncoder().encode(senha);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
      const senhaHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const usuario = await env.DB.prepare("SELECT * FROM usuarios WHERE email = ? AND senha_hash = ?")
        .bind(email, senhaHash)
        .first();

      if (usuario) {
        return new Response(JSON.stringify({ 
          success: true, 
          user: { nome: usuario.nome, pixel_id: usuario.pixel_id, plano: usuario.plano } 
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } else {
        return new Response(JSON.stringify({ error: "Credenciais inválidas" }), { 
          status: 401, headers: corsHeaders 
        });
      }
    }

    return new Response("Atria Auth API", { headers: corsHeaders });
  }
};
