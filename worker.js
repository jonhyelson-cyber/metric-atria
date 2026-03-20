// ═══════════════════════════════════════════════════════════════════
// ATRIA AI BACKEND — Cloudflare Worker
// Endpoints: /cadastro  /login  /chat  /me  /logout
//            /webhook/mp  /planos
// Bindings:  DB (D1)  |  ANTHROPIC_API_KEY  |  MP_ACCESS_TOKEN
// ═══════════════════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Helpers ─────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function err(msg, status = 400) {
  return json({ ok: false, erro: msg }, status);
}

// Hash simples com Web Crypto (SHA-256)
async function hashSenha(senha) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(senha + "atria_salt_2026")
  );
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Gera token de sessão aleatório
function gerarToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Extrai token do header Authorization
function extrairToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

// Valida sessão e retorna usuário
async function autenticar(request, DB) {
  const token = extrairToken(request);
  if (!token) return null;

  const agora = new Date().toISOString();
  const sessao = await DB.prepare(
    "SELECT s.usuario_id, u.nome, u.email, u.plano, u.tokens_usados, u.tokens_limite, u.perguntas_hoje, u.data_reset_diario FROM sessoes s JOIN usuarios u ON s.usuario_id = u.id WHERE s.token = ? AND s.expira_em > ?"
  ).bind(token, agora).first();

  return sessao || null;
}

// Verifica e reseta cota diária se necessário
async function verificarCotaDiaria(usuario, DB) {
  const hoje = new Date().toISOString().slice(0, 10);

  if (usuario.data_reset_diario !== hoje) {
    await DB.prepare(
      "UPDATE usuarios SET perguntas_hoje = 0, data_reset_diario = ? WHERE id = ?"
    ).bind(hoje, usuario.usuario_id).run();
    usuario.perguntas_hoje = 0;
  }

  const limite_diario = usuario.plano === "gratuito" ? 5 : 99999;
  if (usuario.perguntas_hoje >= limite_diario) {
    return { ok: false, erro: usuario.plano === "gratuito"
      ? "Você atingiu o limite de 5 perguntas gratuitas hoje. Faça upgrade para continuar."
      : "Limite diário atingido." };
  }

  if (usuario.tokens_usados >= usuario.tokens_limite) {
    return { ok: false, erro: "Seus tokens mensais foram esgotados. Adquira créditos avulsos ou faça upgrade." };
  }

  return { ok: true };
}

// ── Roteador principal ───────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ── POST /cadastro ──────────────────────────────────────────────
    if (path === "/cadastro" && request.method === "POST") {
      try {
        const { nome, email, whatsapp, senha } = await request.json();

        if (!nome || !email || !senha) return err("Nome, email e senha são obrigatórios.");
        if (senha.length < 8) return err("Senha deve ter no mínimo 8 caracteres.");

        const existe = await env.DB.prepare("SELECT id FROM usuarios WHERE email = ?").bind(email).first();
        if (existe) return err("Email já cadastrado.", 409);

        const hash = await hashSenha(senha);
        const result = await env.DB.prepare(
          "INSERT INTO usuarios (nome, email, whatsapp, senha_hash) VALUES (?, ?, ?, ?)"
        ).bind(nome, email.toLowerCase().trim(), whatsapp || null, hash).run();

        const usuario_id = result.meta.last_row_id;
        const token = gerarToken();
        const expira = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        await env.DB.prepare(
          "INSERT INTO sessoes (usuario_id, token, expira_em) VALUES (?, ?, ?)"
        ).bind(usuario_id, token, expira).run();

        return json({ ok: true, token, usuario: { nome, email, plano: "gratuito" } }, 201);

      } catch (e) {
        return err("Erro interno: " + e.message, 500);
      }
    }

    // ── POST /login ─────────────────────────────────────────────────
    if (path === "/login" && request.method === "POST") {
      try {
        const { email, senha } = await request.json();
        if (!email || !senha) return err("Email e senha são obrigatórios.");

        const hash = await hashSenha(senha);
        const usuario = await env.DB.prepare(
          "SELECT id, nome, email, plano FROM usuarios WHERE email = ? AND senha_hash = ? AND ativo = 1"
        ).bind(email.toLowerCase().trim(), hash).first();

        if (!usuario) return err("Email ou senha incorretos.", 401);

        const token = gerarToken();
        const expira = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        await env.DB.prepare(
          "INSERT INTO sessoes (usuario_id, token, expira_em) VALUES (?, ?, ?)"
        ).bind(usuario.id, token, expira).run();

        return json({ ok: true, token, usuario: { nome: usuario.nome, email: usuario.email, plano: usuario.plano } });

      } catch (e) {
        return err("Erro interno: " + e.message, 500);
      }
    }

    // ── GET /me ─────────────────────────────────────────────────────
    if (path === "/me" && request.method === "GET") {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);

      return json({
        ok: true,
        usuario: {
          nome: usuario.nome,
          email: usuario.email,
          plano: usuario.plano,
          tokens_usados: usuario.tokens_usados,
          tokens_limite: usuario.tokens_limite,
          perguntas_hoje: usuario.perguntas_hoje,
        }
      });
    }

    // ── POST /logout ─────────────────────────────────────────────────
    if (path === "/logout" && request.method === "POST") {
      const token = extrairToken(request);
      if (token) await env.DB.prepare("DELETE FROM sessoes WHERE token = ?").bind(token).run();
      return json({ ok: true });
    }

    // ── POST /chat ───────────────────────────────────────────────────
    if (path === "/chat" && request.method === "POST") {
      try {
        const usuario = await autenticar(request, env.DB);
        if (!usuario) return err("Não autenticado.", 401);

        // Verifica cota
        const cota = await verificarCotaDiaria(usuario, env.DB);
        if (!cota.ok) return err(cota.erro, 429);

        const { mensagem } = await request.json();
        if (!mensagem || mensagem.trim().length === 0) return err("Mensagem vazia.");
        if (mensagem.length > 4000) return err("Mensagem muito longa. Máximo 4000 caracteres.");

        // Busca histórico recente (últimas 10 msgs para contexto)
        const historico = await env.DB.prepare(
          "SELECT role, conteudo FROM conversas WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 10"
        ).bind(usuario.usuario_id).all();

        const msgs_historico = (historico.results || []).reverse().map(m => ({
          role: m.role,
          content: m.conteudo,
        }));

        // Adiciona mensagem atual
        msgs_historico.push({ role: "user", content: mensagem });

        // Chama Claude Haiku
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            system: `Você é a Atria AI, uma assistente de inteligência artificial especializada em ajudar empreendedores e empresários brasileiros. 
Você responde sempre em português brasileiro, de forma clara, objetiva e prática.
Você entende o contexto do mercado brasileiro: Pix, boleto, MEI, CNPJ, NF-e, marketplaces brasileiros, campanhas de marketing digital, e-commerce, infoprodutos.
Seja direto, útil e amigável. Evite respostas genéricas — dê exemplos práticos sempre que possível.`,
            messages: msgs_historico,
          }),
        });

        const data = await resp.json();

        if (data.error) return err("Erro na IA: " + data.error.message, 500);

        const resposta = data.content[0].text;
        const tokens_entrada = data.usage?.input_tokens || 0;
        const tokens_saida = data.usage?.output_tokens || 0;
        const tokens_total = tokens_entrada + tokens_saida;

        // Salva conversa no D1
        await env.DB.prepare(
          "INSERT INTO conversas (usuario_id, role, conteudo, tokens) VALUES (?, 'user', ?, ?)"
        ).bind(usuario.usuario_id, mensagem, tokens_entrada).run();

        await env.DB.prepare(
          "INSERT INTO conversas (usuario_id, role, conteudo, tokens) VALUES (?, 'assistant', ?, ?)"
        ).bind(usuario.usuario_id, resposta, tokens_saida).run();

        // Atualiza contadores
        await env.DB.prepare(
          "UPDATE usuarios SET tokens_usados = tokens_usados + ?, perguntas_hoje = perguntas_hoje + 1 WHERE id = ?"
        ).bind(tokens_total, usuario.usuario_id).run();

        return json({
          ok: true,
          resposta,
          tokens_usados: tokens_total,
          perguntas_hoje: usuario.perguntas_hoje + 1,
        });

      } catch (e) {
        return err("Erro interno: " + e.message, 500);
      }
    }

    // ── GET /historico ───────────────────────────────────────────────
    if (path === "/historico" && request.method === "GET") {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);

      const historico = await env.DB.prepare(
        "SELECT role, conteudo, criado_em FROM conversas WHERE usuario_id = ? ORDER BY criado_em ASC LIMIT 50"
      ).bind(usuario.usuario_id).all();

      return json({ ok: true, mensagens: historico.results || [] });
    }

    // ── GET /planos ──────────────────────────────────────────────────
    if (path === "/planos" && request.method === "GET") {
      return json({
        ok: true,
        planos: [
          {
            id: "start",
            nome: "Start",
            preco: 47,
            tokens: 500000,
            link: "https://mpago.la/1hfW7Sf",
          },
          {
            id: "elite",
            nome: "Elite",
            preco: 97,
            tokens: 2000000,
            link: "https://mpago.la/2HxT9Bn",
          },
        ],
      });
    }

    // ── POST /webhook/mp ─────────────────────────────────────────────
    if (path === "/webhook/mp" && request.method === "POST") {
      try {
        const body = await request.json();

        // MP envia type=payment quando pagamento é aprovado
        if (body.type !== "payment") return json({ ok: true });

        const payment_id = body.data?.id;
        if (!payment_id) return json({ ok: true });

        // Consulta o pagamento na API do MP
        const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
          headers: { "Authorization": `Bearer ${env.MP_ACCESS_TOKEN}` },
        });
        const pagamento = await mpRes.json();

        // Só processa pagamentos aprovados
        if (pagamento.status !== "approved") return json({ ok: true });

        const valor = pagamento.transaction_amount;
        const email = pagamento.payer?.email?.toLowerCase().trim();

        if (!email) return json({ ok: true });

        // Define plano e tokens baseado no valor pago
        let plano = null;
        let tokens_limite = 0;

        if (valor >= 47 && valor < 97) {
          plano = "start";
          tokens_limite = 500000;
        } else if (valor >= 97) {
          plano = "elite";
          tokens_limite = 2000000;
        }

        if (!plano) return json({ ok: true });

        // Atualiza usuário no D1
        const usuario = await env.DB.prepare(
          "SELECT id FROM usuarios WHERE email = ?"
        ).bind(email).first();

        if (usuario) {
          await env.DB.prepare(
            "UPDATE usuarios SET plano = ?, tokens_limite = ?, tokens_usados = 0 WHERE id = ?"
          ).bind(plano, tokens_limite, usuario.id).run();

          // Salva registro do pagamento
          await env.DB.prepare(
            "INSERT INTO creditos (usuario_id, tokens, origem) VALUES (?, ?, ?)"
          ).bind(usuario.id, tokens_limite, `mp_payment_${payment_id}`).run();
        }

        return json({ ok: true });

      } catch (e) {
        // Sempre retorna 200 para o MP não retentar
        return json({ ok: true });
      }
    }

    // ── 404 ──────────────────────────────────────────────────────────
    return err("Rota não encontrada.", 404);
  },
};
