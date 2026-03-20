// ═══════════════════════════════════════════════════════════════════
// ATRIA AI BACKEND — Cloudflare Worker
// Endpoints: /cadastro  /login  /chat  /me  /logout
//            /webhook/mp  /webhook/kiwify  /planos  /feedback
//            /admin/feedbacks  /admin/stats  /admin/usuarios
//            /brain/index  /brain/query  /brain/status
//            /brain/files  /brain/files/:id  /brain/files/:id/restore
//            /gerar-imagem  (Flux.1 Schnell - Cloudflare Workers AI)
// Bindings:  DB (D1) | AI | CACHE (KV) | VECTORIZE | BRAIN_FILES (R2)
//            ANTHROPIC_API_KEY | MP_ACCESS_TOKEN | KIWIFY_WEBHOOK_TOKEN
// ═══════════════════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function err(msg, status = 400) {
  return json({ ok: false, erro: msg }, status);
}

async function hashSenha(senha) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(senha + "atria_salt_2026")
  );
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function enviarEmailRecuperacao(email, nome, token, env) {
  const link = `https://atria-ai-backend.jonhyelson.workers.dev/redefinir-senha?token=${token}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Atria AI <noreply@ai.atriapay.com.br>",
      to: [email],
      subject: "Redefinição de senha — Atria AI",
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#0a0a0f;color:#f0f0f5;border-radius:16px;">
          <div style="text-align:center;margin-bottom:32px;">
            <div style="display:inline-block;background:linear-gradient(135deg,#00d4d4,#9b7fff);border-radius:10px;padding:10px 18px;font-size:20px;font-weight:700;color:#000;">
              Atria AI
            </div>
          </div>
          <h2 style="font-size:22px;margin-bottom:8px;color:#f0f0f5;">Olá, ${nome} 👋</h2>
          <p style="color:#a0a0b0;margin-bottom:24px;line-height:1.6;">
            Recebemos uma solicitação para redefinir a senha da sua conta. Clique no botão abaixo para criar uma nova senha.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#00d4d4,#9b7fff);color:#000;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none;">
              Redefinir minha senha →
            </a>
          </div>
          <p style="color:#6b6b80;font-size:13px;margin-top:24px;line-height:1.6;">
            Este link expira em <strong style="color:#a0a0b0;">1 hora</strong>. Se você não solicitou a redefinição, ignore este email — sua senha permanece a mesma.
          </p>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,0.07);margin:28px 0;"/>
          <p style="color:#6b6b80;font-size:12px;text-align:center;">
            Atria AI · Manaus, Amazonas · 🌿 3% da receita vai para a Amazônia
          </p>
        </div>
      `,
    }),
  });
  if (!res.ok) {
    const erro = await res.text();
    throw new Error(`Resend erro ${res.status}: ${erro}`);
  }
  return true;
}

function gerarToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

function gerarRefCode() {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function premiarIndicador(uid, DB) {
  try {
    const indicado = await DB.prepare("SELECT indicado_por FROM usuarios WHERE id = ?").bind(uid).first();
    if (!indicado?.indicado_por) return;
    await DB.prepare("UPDATE usuarios SET tokens_limite = tokens_limite + 200000, indicacoes_convertidas = indicacoes_convertidas + 1 WHERE id = ?")
      .bind(indicado.indicado_por).run();
    await DB.prepare("INSERT INTO creditos (usuario_id, tokens, origem) VALUES (?, ?, ?)")
      .bind(indicado.indicado_por, 200000, `indicacao_uid_${uid}`).run();
  } catch(e) { /* falha silenciosa */ }
}

function extrairToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

async function autenticar(request, DB) {
  const token = extrairToken(request);
  if (!token) return null;
  const agora = new Date().toISOString();
  const sessao = await DB.prepare(
    "SELECT s.usuario_id, u.nome, u.email, u.plano, u.tokens_usados, u.tokens_limite, u.perguntas_hoje, u.data_reset_diario, u.has_brain, u.brain_status, u.has_atria_voice, u.atria_trial_inicio, u.atria_trial_usado FROM sessoes s JOIN usuarios u ON s.usuario_id = u.id WHERE s.token = ? AND s.expira_em > ?"
  ).bind(token, agora).first();
  return sessao || null;
}

async function verificarCotaDiaria(usuario, DB, modelo_escolhido, extra = {}) {
  const hoje = new Date().toISOString().slice(0, 10);
  if (usuario.data_reset_diario !== hoje) {
    await DB.prepare("UPDATE usuarios SET perguntas_hoje = 0, data_reset_diario = ? WHERE id = ?")
      .bind(hoje, usuario.usuario_id).run();
    usuario.perguntas_hoje = 0;
  }
  const plano = usuario.plano || "gratuito";
  const acessoModelo = {
    gratuito: ["llama", "deepseek", "haiku"],
    start:    ["llama", "deepseek", "haiku"],
    pro:      ["llama", "deepseek", "haiku", "sonnet"],
    elite:    ["llama", "deepseek", "haiku", "sonnet", "opus"],
  };
  if (modelo_escolhido === "haiku" && extra?.pedeArtefato && plano === "gratuito") {
    return { ok: false, erro: "🔒 Apresentações e código estão disponíveis a partir do Plano Start." };
  }
  const permitidos = acessoModelo[plano] || acessoModelo.gratuito;
  if (modelo_escolhido && !permitidos.includes(modelo_escolhido)) {
    const msgs = {
      sonnet: "🔒 Respostas avançadas estão disponíveis a partir do Plano Pro.",
      opus:   "🔒 Máxima inteligência está disponível apenas no Plano Elite.",
    };
    return { ok: false, erro: msgs[modelo_escolhido] || "🔒 Faça upgrade para acessar este recurso." };
  }
  if (plano === "gratuito" && usuario.perguntas_hoje >= 20) {
    return { ok: false, erro: "Você atingiu o limite de 20 perguntas gratuitas hoje. Volte amanhã ou faça upgrade! 🚀" };
  }
  if (plano !== "gratuito" && usuario.tokens_usados >= usuario.tokens_limite) {
    return { ok: false, erro: "Seus tokens foram esgotados. Adquira créditos avulsos ou faça upgrade." };
  }
  return { ok: true };
}

function extrairTextoResposta(content) {
  if (!Array.isArray(content)) return content || "";
  return content
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("\n")
    .trim();
}

function chunkTexto(texto, tamanho = 1000) {
  const sobreposicao = Math.floor(tamanho * 0.1);
  const chunks = [];
  let inicio = 0;
  while (inicio < texto.length) {
    const fim = Math.min(inicio + tamanho, texto.length);
    chunks.push(texto.slice(inicio, fim));
    if (fim === texto.length) break;
    inicio += tamanho - sobreposicao;
  }
  return chunks;
}

async function arquivarArquivosInativos(env) {
  const limite = new Date();
  limite.setDate(limite.getDate() - 30);
  const dataLimite = limite.toISOString();

  let candidatos = [];
  try {
    const res = await env.DB.prepare(`
      SELECT id, usuario_id, nome_arquivo, total_chunks, r2_key
      FROM brain_documents
      WHERE no_vectorize = 1 AND ultimo_acesso < ?
      LIMIT 200
    `).bind(dataLimite).all();
    candidatos = res.results || [];
  } catch(e) {
    console.error("[brain-archive] Erro ao buscar candidatos:", e.message);
    return;
  }

  if (!candidatos.length) {
    console.log("[brain-archive] Nenhum arquivo para arquivar.");
    return;
  }

  console.log(`[brain-archive] Arquivando ${candidatos.length} arquivo(s)...`);

  for (const doc of candidatos) {
    try {
      const obj = await env.BRAIN_FILES.get(doc.r2_key);
      if (!obj) {
        await env.DB.prepare("UPDATE brain_documents SET no_vectorize = 0 WHERE id = ?").bind(doc.id).run();
        continue;
      }

      if (doc.vector_prefix) {
        const vectorIds = Array.from(
          { length: doc.total_chunks },
          (_, i) => `${doc.vector_prefix}_${i}`
        );
        for (let i = 0; i < vectorIds.length; i += 1000) {
          await env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 1000)).catch(() => {});
        }
      }

      await env.DB.prepare("UPDATE brain_documents SET no_vectorize = 0 WHERE id = ?").bind(doc.id).run();
      console.log(`[brain-archive] ✓ Arquivado: ${doc.nome_arquivo} (id=${doc.id})`);
    } catch (e) {
      console.error(`[brain-archive] ✗ Erro em doc ${doc.id}:`, e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// FLUX.1 SCHNELL — Geração de Imagens (Cloudflare Workers AI)
// ═══════════════════════════════════════════════════════════════════

async function gerarImagemFlux(prompt, estilo, env) {
  const estilosMap = {
    realista: "photorealistic, ultra realistic, 8k, high detail, professional photography, natural lighting, sharp focus",
    pintura: "oil painting, canvas texture, brush strokes, masterpiece, artistic, gallery quality, impressionist",
    aquarela: "watercolor painting, soft colors, flowing brush strokes, artistic, delicate, transparent layers",
    ilustracao: "digital illustration, vector art, clean lines, vibrant colors, modern illustration, professional",
    anime: "anime style, manga art, japanese animation, vibrant colors, detailed characters, studio quality",
    cinematic: "cinematic lighting, movie poster style, dramatic composition, epic mood, high contrast",
    desenho: "hand drawing, sketch style, pencil art, detailed lines, artistic sketch, charcoal"
  };
  
  const estiloPrompt = estilosMap[estilo] || estilosMap.realista;
  
  const atriaStyle = `Style: ${estiloPrompt}. Color palette: neon cyan #00d4d4 and purple #9b7fff. Dark background #0a0a0f. Professional, brazilian market aesthetic.`;
  
  const fullPrompt = `${prompt}. ${atriaStyle}`;
  
  console.log("[Flux] Prompt enviado:", fullPrompt);
  
  // Chamada para o modelo Flux.1 Schnell
  const response = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
    prompt: fullPrompt,
    num_steps: 8,
    guidance: 3.5,
    width: 1024,
    height: 1024
  });
  
  console.log("[Flux] Tipo da resposta:", typeof response);
  console.log("[Flux] Chaves da resposta:", response ? Object.keys(response).join(", ") : "resposta vazia");
  
  // Extrai a imagem da resposta
  let imageBuffer = null;
  
  if (response && response.image) {
    imageBuffer = response.image;
    console.log("[Flux] Imagem encontrada em response.image");
  } else if (response && response.output && response.output.image) {
    imageBuffer = response.output.image;
    console.log("[Flux] Imagem encontrada em response.output.image");
  } else if (response && typeof response === 'object' && !response.image) {
    // Pode ser que a resposta seja o próprio buffer
    imageBuffer = response;
    console.log("[Flux] Tentando usar a própria resposta como buffer");
  }
  
  if (!imageBuffer) {
    console.error("[Flux] Resposta completa:", JSON.stringify(response).substring(0, 500));
    throw new Error("Flux não retornou imagem válida.");
  }
  
  // Converte para base64
  let base64;
  try {
    const uint8Array = imageBuffer instanceof ArrayBuffer 
      ? new Uint8Array(imageBuffer)
      : imageBuffer;
    
    // Converte Uint8Array para string base64
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    base64 = btoa(binary);
    
    console.log("[Flux] Imagem convertida com sucesso. Tamanho base64:", base64.length);
    
  } catch (e) {
    console.error("[Flux] Erro na conversão:", e.message);
    throw new Error("Erro ao converter imagem para base64: " + e.message);
  }
  
  return base64;
}

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPTS
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_BASE = `Você é a Atria AI — assistente de IA para empreendedores e profissionais brasileiros.
Responda SEMPRE em português brasileiro, independente do idioma das fontes consultadas.
Entende o contexto brasileiro: Pix, MEI, CNPJ, NF-e, legislação trabalhista.

ESTILO:
- Seja DIRETO e CONCISO. Vá direto ao ponto sem introduções.
- NUNCA comece com "Claro!", "Ótima pergunta!", "Com prazer!", "Certamente!" ou similares.
- NUNCA faça resumo ou conclusão no final.
- Perguntas simples: 1 a 3 frases. Análises: bullet points curtos.
- Use títulos e listas só quando necessário.

REGRAS:
- Nunca recuse uma pergunta legítima.
- Você tem acesso ao Cérebro e aos arquivos enviados — nunca diga o contrário.
- Você CONSEGUE ver e analisar imagens. Analise diretamente.`;

const PERSONAS = {
  advogado: `Você é um advogado especialista brasileiro. Linguagem jurídica precisa mas acessível.
Cite artigos de lei e jurisprudência quando relevante.
Foque em: contratos, trabalhista, empresarial, tributário, cível.
Oriente o usuário a buscar assessoria profissional para casos específicos.`,
  contador: `Você é um contador e especialista fiscal brasileiro. Precisão técnica.
Domina: MEI, Simples Nacional, Lucro Presumido, IRPJ, CSLL, PIS, COFINS, SPED, eSocial.
Ajuda com: DRE, fluxo de caixa, planejamento tributário, obrigações acessórias.`,
  copywriter: `Você é um copywriter e especialista em marketing digital brasileiro.
Cria textos persuasivos com gatilhos mentais. Entende funil de vendas, Meta Ads, Google Ads.
Escreva de forma direta, envolvente e com CTA claro.`,
  coach: `Você é um coach executivo brasileiro. Motivador mas prático.
Ajuda com: produtividade, liderança, metas SMART, OKRs.
Linguagem positiva, direta e encorajadora.`,
  dev: `Você é um desenvolvedor sênior full-stack. Código limpo e explicações técnicas precisas.
Domina: JavaScript, TypeScript, Python, React, Node.js, SQL, APIs REST, Cloudflare Workers.
Prefere exemplos práticos a explicações teóricas longas.`,
  empreendedor: `Você é um mentor de negócios brasileiro. Direto e prático.
Ajuda com: modelo de negócio, validação, precificação, pitch, escalabilidade.
Pense como um cofundador experiente.`,
};

const SYSTEM_PROMPT_APRESENTACAO = `Você é a Atria AI, especialista em apresentações profissionais em português brasileiro.
Responda SOMENTE com JSON válido, sem texto antes ou depois:
{"titulo":"Título","resumo":"1-2 frases.","slides":[{"titulo":"Título","conteudo":["Tópico 1","Tópico 2"],"nota":"opcional"}]}
Regras: primeiro slide é a capa, crie 6-12 slides, 3-6 tópicos por slide, português brasileiro.
Se tiver contexto do Cérebro disponível, use-o. Se não, crie com base no tema solicitado.`;

const SYSTEM_PROMPT_CODIGO = `Você é a Atria AI, especialista em desenvolvimento.
Responda SOMENTE com JSON válido, sem texto antes ou depois:
{"titulo":"Nome do arquivo","linguagem":"html|javascript|python|sql|outro","resumo":"1-2 frases.","codigo":"código completo aqui"}
Regras: sites usam "html" com CSS/JS embutidos, código sempre completo e funcional, comentários em português.`;

const SUPORTE_PUBLICO_SYSTEM = `Você é a Atria Suporte — agente de atendimento da Atria AI, plataforma brasileira de inteligência artificial.
PLANOS: Gratuito (20 perguntas/dia grátis) | Start R$47/mês (ilimitado+busca web) | Pro R$97/mês (Start+Sonnet+Cérebro) | Elite R$297/mês (Pro+Opus+Extended Thinking)
CÉREBRO: Memória vetorial — memoriza PDFs, Word, Excel. Ativar em Perfil → toggle Cérebro. Usar: botão 🧠 na toolbar do chat.
ATRIA VOICE: Voz neural Azure premium. Ativar: botão "Atria" no chat. Falar "Atria [comando]". Funciona só no Chrome. R$9,99/mês ou 7 dias grátis.
FUNCIONALIDADES: busca web em tempo real (Start+), análise de imagens (todos), personas (Advogado/Contador/Copywriter/Coach/Dev/Empreendedor), YouTube/links, PWA instalável.
PROBLEMAS COMUNS:
- Microfone bloqueado → cadeado na barra do navegador → Microfone → Permitir → recarregar página
- Atria Voice não funciona → usar Chrome (Edge não suporta)
- PIX não confirmou → aguardar até 5 minutos → verificar email
- Cérebro não ativa → Perfil → toggle Cérebro → aguardar ativação
- Tokens esgotados → Perfil → Comprar créditos ou fazer upgrade
CANCELAMENTO: Perfil → Plano → Cancelar assinatura. Encerra na próxima renovação.
REEMBOLSO: Solicitar em até 7 dias. Orientar a enviar mensagem pelo Perfil → Sugestões.
REGRAS:
- Simpático, direto e empático. Máximo 3 parágrafos curtos.
- Nunca invente funcionalidades que não existem.
- Se não conseguir resolver o problema, SEMPRE orientar: "Não consegui resolver? Envie uma mensagem detalhada em Perfil → Sugestões que nossa equipe responde em até 24h."
- Sempre em português brasileiro.`;

const SUPORTE_LEADS_SYSTEM = `Você é a Atria, assistente de vendas da Atria AI — plataforma brasileira de inteligência artificial para empreendedores.
SOBRE A ATRIA AI: IA especializada no contexto brasileiro — MEI, CNPJ, NF-e, Pix, legislação trabalhista. Não é um ChatGPT genérico.
PLANOS:
- Gratuito: 20 perguntas/dia, sem cartão
- Start R$47/mês: perguntas ilimitadas + busca web em tempo real + análise de documentos (300 páginas)
- Pro R$97/mês: Start + modelo Sonnet (mais inteligente) + Cérebro (memória vetorial de documentos)
- Elite R$297/mês: Pro + modelo Opus (máxima inteligência) + Extended Thinking
MÓDULOS OPCIONAIS: Cérebro R$9,99/mês (memória de PDFs/Word/Excel) | Atria Voice R$9,99/mês (assistente por voz tipo Alexa)
DIFERENCIAIS: 5 modelos de IA, busca web em tempo real, voz neural Azure, personas especializadas (advogado, contador, copywriter), PWA instalável no celular.
REGRAS:
- Tom amigável e consultivo, nunca agressivo.
- Foco em entender a necessidade do visitante e mostrar qual plano resolve.
- Incentive a criar conta gratuita para experimentar.
- Máximo 3 parágrafos. Nunca minta sobre funcionalidades.
- Sempre em português brasileiro.`;

const SUPORTE_ADMIN_SYSTEM = `Você é o agente de suporte interno da Atria AI — plataforma brasileira de IA.
PLANOS: Gratuito (20 perguntas/dia), Start (R$47/mês), Pro (R$97/mês), Elite (R$297/mês).
MODELOS: Gratuito=Llama/DeepSeek/Haiku. Start+=busca web. Pro+=Sonnet. Elite+=Opus+Extended Thinking.
MÓDULOS: Cérebro (memória vetorial PDF/Word/Excel), Personas, PWA instalável.
PAGAMENTO: PIX via Paytime/Kiwify. BACKEND: Cloudflare Workers+D1+Vectorize+R2. API: Anthropic.
INSTRUÇÕES: Direto e prático. Sugira texto pronto quando pedido. Identifique se é bug, dúvida ou pagamento. Português brasileiro.`;

const KEYWORDS_BUSCA_WEB = /hoje|agora|not[ií]cia|pre[çc]o|[úu]ltimo|recente|atual|2024|2025|2026|quem [ée]|quando foi|quanto custa|novidade|cota[çc][aã]o|d[oó]lar|bitcoin|ethereum|crypto|cripto|ouro|selic|ibovespa|taxa|juros|infla[çc][aã]o|câmbio|cambio|mercado|bolsa|a[çc][aã]o|acoes|ações|clima|tempo|chuva|chover|previs[aã]o|temperatura|calor|frio|vento|umidade/i;

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, erro: "Erro interno: " + e.message }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(arquivarArquivosInativos(env));
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: GERAR IMAGEM (Flux.1 Schnell - Cloudflare Workers AI)
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/gerar-imagem" && request.method === "POST") {
    try {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);
      
      const { prompt, estilo } = await request.json();
      if (!prompt?.trim()) return err("Prompt obrigatório.", 400);
      
      const CUSTO_IMAGEM = 0;
      const plano = usuario.plano || "gratuito";
      
      if (plano === "gratuito") {
        return err("🔒 Geração de imagens disponível a partir do Plano Start. Faça upgrade para criar imagens.", 403);
      }
      
      const tokensUsados = usuario.tokens_usados || 0;
      const tokensLimite = usuario.tokens_limite || 150000;
      const tokensRestantes = tokensLimite - tokensUsados;
      
      const imagemBase64 = await gerarImagemFlux(prompt, estilo, env);
      
      if (CUSTO_IMAGEM > 0) {
        await env.DB.prepare("UPDATE usuarios SET tokens_usados = tokens_usados + ? WHERE id = ?")
          .bind(CUSTO_IMAGEM, usuario.usuario_id).run();
        
        await env.DB.prepare("INSERT INTO creditos (usuario_id, tokens, origem) VALUES (?, ?, ?)")
          .bind(usuario.usuario_id, CUSTO_IMAGEM, `imagem_flux_${Date.now()}`).run();
      }
      
      return json({ 
        ok: true, 
        imagem: imagemBase64,
        custo_tokens: CUSTO_IMAGEM,
        tokens_restantes: tokensRestantes - CUSTO_IMAGEM,
        modelo: "flux-1-schnell"
      });
      
    } catch (e) {
      console.error("[gerar-imagem-flux]", e.message);
      return err("Erro ao gerar imagem: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: CADASTRO
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/cadastro" && request.method === "POST") {
    try {
      const { nome, email, whatsapp, senha, ref } = await request.json();
      if (!nome || !email || !senha) return err("Nome, email e senha são obrigatórios.");
      if (senha.length < 8) return err("Senha deve ter no mínimo 8 caracteres.");
      const existe = await env.DB.prepare("SELECT id FROM usuarios WHERE email = ?").bind(email).first();
      if (existe) return err("Email já cadastrado.", 409);

      let indicado_por = null;
      if (ref) {
        const indicador = await env.DB.prepare("SELECT id FROM usuarios WHERE ref_code = ?").bind(ref.toUpperCase()).first();
        if (indicador) indicado_por = indicador.id;
      }

      const hash = await hashSenha(senha);
      const ref_code = gerarRefCode();
      const result = await env.DB.prepare(
        "INSERT INTO usuarios (nome, email, whatsapp, senha_hash, ref_code, indicado_por) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(nome, email.toLowerCase().trim(), whatsapp || null, hash, ref_code, indicado_por).run();
      const usuario_id = result.meta.last_row_id;
      const token = gerarToken();
      const expira = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare("INSERT INTO sessoes (usuario_id, token, expira_em) VALUES (?, ?, ?)")
        .bind(usuario_id, token, expira).run();
      return json({ ok: true, token, usuario: { nome, email, plano: "gratuito" } }, 201);
    } catch (e) {
      return err("Erro interno: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: LOGIN
  // ═══════════════════════════════════════════════════════════════════

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
      await env.DB.prepare("INSERT INTO sessoes (usuario_id, token, expira_em) VALUES (?, ?, ?)")
        .bind(usuario.id, token, expira).run();
      return json({ ok: true, token, usuario: { nome: usuario.nome, email: usuario.email, plano: usuario.plano } });
    } catch (e) {
      return err("Erro interno: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: ESQUECI SENHA
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/esqueci-senha" && request.method === "POST") {
    try {
      const { email } = await request.json();
      if (!email) return err("Email é obrigatório.");
      const usuario = await env.DB.prepare("SELECT id, nome FROM usuarios WHERE email = ? AND ativo = 1")
        .bind(email.toLowerCase().trim()).first();
      if (!usuario) return json({ ok: true });

      const token = gerarToken();
      const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS reset_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          usuario_id INTEGER NOT NULL,
          token TEXT NOT NULL UNIQUE,
          expira_em TEXT NOT NULL,
          usado INTEGER DEFAULT 0,
          criado_em TEXT DEFAULT (datetime('now'))
        )
      `).run();

      await env.DB.prepare("DELETE FROM reset_tokens WHERE usuario_id = ?").bind(usuario.id).run();
      await env.DB.prepare("INSERT INTO reset_tokens (usuario_id, token, expira_em) VALUES (?, ?, ?)")
        .bind(usuario.id, token, expira).run();

      await enviarEmailRecuperacao(email, usuario.nome, token, env);
      return json({ ok: true });
    } catch (e) {
      console.error("[esqueci-senha]", e.message);
      return json({ ok: true });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: REDEFINIR SENHA
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/redefinir-senha" && request.method === "POST") {
    try {
      const { token, senha } = await request.json();
      if (!token || !senha) return err("Token e nova senha são obrigatórios.");
      if (senha.length < 8) return err("Senha deve ter no mínimo 8 caracteres.");

      const agora = new Date().toISOString();
      const registro = await env.DB.prepare(
        "SELECT usuario_id FROM reset_tokens WHERE token = ? AND expira_em > ? AND usado = 0"
      ).bind(token, agora).first();

      if (!registro) return err("Link inválido ou expirado. Solicite um novo.", 400);

      const novoHash = await hashSenha(senha);
      await env.DB.prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?")
        .bind(novoHash, registro.usuario_id).run();
      await env.DB.prepare("UPDATE reset_tokens SET usado = 1 WHERE token = ?")
        .bind(token).run();
      await env.DB.prepare("DELETE FROM sessoes WHERE usuario_id = ?")
        .bind(registro.usuario_id).run();

      return json({ ok: true, mensagem: "Senha redefinida com sucesso!" });
    } catch (e) {
      return err("Erro ao redefinir senha: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: ME
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/me" && request.method === "GET") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    
    let ref_code = null, indicacoes_convertidas = 0;
    try {
      const extra = await env.DB.prepare("SELECT ref_code, indicacoes_convertidas FROM usuarios WHERE id = ?").bind(usuario.usuario_id).first();
      ref_code = extra?.ref_code || null;
      indicacoes_convertidas = extra?.indicacoes_convertidas || 0;
      if (!ref_code) {
        ref_code = gerarRefCode();
        await env.DB.prepare("UPDATE usuarios SET ref_code = ? WHERE id = ?").bind(ref_code, usuario.usuario_id).run().catch(() => {});
      }
    } catch(e) {}

    const tokensUsados = usuario.tokens_usados || 0;
    const tokensLimite = usuario.tokens_limite || 150000;
    const tokensRestantes = tokensLimite - tokensUsados;
    const imagensDisponiveis = Math.floor(tokensRestantes / 5000);

    return json({
      ok: true,
      usuario: {
        nome: usuario.nome,
        email: usuario.email,
        plano: usuario.plano,
        tokens_usados: usuario.tokens_usados,
        tokens_limite: usuario.tokens_limite,
        perguntas_hoje: usuario.perguntas_hoje,
        has_brain: !!usuario.has_brain,
        brain_status: usuario.brain_status || "inactive",
        ref_code,
        indicacoes_convertidas,
        has_atria_voice: !!usuario.has_atria_voice,
        atria_trial_inicio: usuario.atria_trial_inicio || null,
        atria_trial_usado: !!usuario.atria_trial_usado,
        imagens_disponiveis: imagensDisponiveis,
        custo_imagem_tokens: 5000,
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: ATRIA VOICE TRIAL
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/atria-voice/trial" && request.method === "POST") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    if (usuario.atria_trial_usado) return err("Trial já utilizado.", 400);
    if (usuario.has_atria_voice) return err("Atria Voice já ativo.", 400);
    const agora = new Date().toISOString();
    await env.DB.prepare("UPDATE usuarios SET atria_trial_inicio = ?, atria_trial_usado = 1 WHERE id = ?").bind(agora, usuario.usuario_id).run();
    return json({ ok: true, trial_inicio: agora });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: CRIAR PAGAMENTO ATRIA
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/criar-pagamento-atria" && request.method === "POST") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    return json({ ok: true, url: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=7a58c91d66e44ac68574e90ab3c34b89" });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: LOGOUT
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/logout" && request.method === "POST") {
    const token = extrairToken(request);
    if (token) await env.DB.prepare("DELETE FROM sessoes WHERE token = ?").bind(token).run();
    return json({ ok: true });
  }

  // ═══════════════════════════════════════════════════════════════════
  // MÓDULO CÉREBRO - INDEX
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/brain/index" && request.method === "POST") {
    try {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);
      if (!usuario.has_brain || usuario.brain_status !== "active") {
        return err("🧠 Módulo Cérebro não ativo. Assine por R$9,99/mês para usar.", 403);
      }
      const { texto, fonte } = await request.json();
      if (!texto?.trim()) return err("Texto obrigatório.");

      const textoTrimmed = texto.trim();
      const tamanho = textoTrimmed.length;
      const PEQUENO = tamanho <= 50000;
      const chunkSize = PEQUENO ? 4000 : 6000;
      const usarR2Chunks = !PEQUENO;

      const chunks = chunkTexto(textoTrimmed, chunkSize);
      const chunksLimitados = chunks.slice(0, 500);
      const loteId = `u${usuario.usuario_id}_${Date.now()}`;
      const vectorInserts = [];

      for (let b = 0; b < chunksLimitados.length; b += 20) {
        const batchTextos = chunksLimitados.slice(b, b + 20);
        const embedding = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: batchTextos });
        batchTextos.forEach((chunkText, j) => {
          const i = b + j;
          vectorInserts.push({
            id: `${loteId}_${i}`,
            values: embedding.data[j],
            metadata: PEQUENO
              ? { text: chunkText, source: fonte || "documento", usuario_id: String(usuario.usuario_id) }
              : { r2_chunk_key: `${loteId}_chunk_${i}`, source: fonte || "documento", usuario_id: String(usuario.usuario_id), chunk_index: i, total_chunks: chunksLimitados.length }
          });
        });
      }

      for (let i = 0; i < vectorInserts.length; i += 200) {
        await env.VECTORIZE.upsert(vectorInserts.slice(i, i + 200));
      }

      const nomeArquivo = fonte || "documento";
      const r2Key = `u${usuario.usuario_id}/${Date.now()}_${nomeArquivo.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

      try {
        if (env.BRAIN_FILES) {
          await env.BRAIN_FILES.put(r2Key, textoTrimmed, {
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
            customMetadata: { usuario_id: String(usuario.usuario_id), fonte: nomeArquivo, chunks: String(chunksLimitados.length), tamanho: String(tamanho) }
          });

          if (usarR2Chunks) {
            const chunkSavePromises = chunksLimitados.map((chunkText, i) =>
              env.BRAIN_FILES.put(`${loteId}_chunk_${i}`, chunkText, {
                httpMetadata: { contentType: "text/plain; charset=utf-8" },
                customMetadata: { source: nomeArquivo, chunk_index: String(i), total: String(chunksLimitados.length) }
              })
            );
            for (let i = 0; i < chunkSavePromises.length; i += 20) {
              await Promise.all(chunkSavePromises.slice(i, i + 20));
            }
          }

          const agora = new Date().toISOString();
          await env.DB.prepare(`
            INSERT INTO brain_documents
              (usuario_id, nome_arquivo, r2_key, tamanho_bytes, total_chunks, vector_prefix, no_vectorize, ultimo_acesso, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          `).bind(
            usuario.usuario_id, nomeArquivo, r2Key,
            tamanho, chunksLimitados.length, loteId, agora, agora
          ).run();
        }
      } catch(r2err) {
        console.error("[brain/index] Erro R2/D1:", r2err.message);
      }

      return json({ ok: true, chunks: chunksLimitados.length, mensagem: `✅ ${chunksLimitados.length} blocos memorizados no Cérebro!` });
    } catch (e) {
      return err("Erro ao indexar: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MÓDULO CÉREBRO - FILES
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/brain/files" && request.method === "GET") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    if (!usuario.has_brain || usuario.brain_status !== "active") {
      return err("🧠 Módulo Cérebro não ativo.", 403);
    }
    try {
      const { results } = await env.DB.prepare(`
        SELECT id, nome_arquivo AS nome, total_chunks AS chunks,
               no_vectorize, r2_key, ultimo_acesso, criado_em,
               CASE WHEN no_vectorize = 1 THEN 'active' ELSE 'archived' END AS status
        FROM brain_documents
        WHERE usuario_id = ?
        ORDER BY criado_em DESC
        LIMIT 100
      `).bind(usuario.usuario_id).all();

      return json({ ok: true, files: results || [] });
    } catch(e) {
      return json({ ok: true, files: [] });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MÓDULO CÉREBRO - DELETE FILE
  // ═══════════════════════════════════════════════════════════════════

  if (path.match(/^\/brain\/files\/[^/]+$/) && request.method === "DELETE") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);

    const docId = path.split("/")[3];

    try {
      const doc = await env.DB.prepare(`
        SELECT id, usuario_id, nome_arquivo, total_chunks, r2_key, vector_prefix, no_vectorize
        FROM brain_documents WHERE id = ?
      `).bind(docId).first();

      if (!doc) return err("Arquivo não encontrado.", 404);
      if (String(doc.usuario_id) !== String(usuario.usuario_id)) return err("Sem permissão.", 403);

      if (doc.no_vectorize === 1 && doc.vector_prefix) {
        const vectorIds = Array.from(
          { length: doc.total_chunks },
          (_, i) => `${doc.vector_prefix}_${i}`
        );
        for (let i = 0; i < vectorIds.length; i += 1000) {
          await env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 1000)).catch(() => {});
        }
      }

      if (doc.r2_key && env.BRAIN_FILES) {
        await env.BRAIN_FILES.delete(doc.r2_key).catch(() => {});
      }

      await env.DB.prepare("DELETE FROM brain_documents WHERE id = ?").bind(docId).run();

      return json({ ok: true, mensagem: "Arquivo removido com sucesso." });
    } catch(e) {
      return err("Erro ao deletar arquivo: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MÓDULO CÉREBRO - QUERY
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/brain/query" && request.method === "POST") {
    try {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);
      if (!usuario.has_brain || usuario.brain_status !== "active") {
        return err("🧠 Módulo Cérebro não ativo.", 403);
      }
      const { pergunta } = await request.json();
      if (!pergunta?.trim()) return err("Pergunta obrigatória.");
      const embedding = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [pergunta] });
      let resultados;
      try {
        resultados = await env.VECTORIZE.query(embedding.data[0], {
          topK: 8,
          returnValues: false,
          returnMetadata: "all",
          filter: { usuario_id: String(usuario.usuario_id) },
        });
      } catch(filterErr) {
        resultados = await env.VECTORIZE.query(embedding.data[0], {
          topK: 10,
          returnValues: false,
          returnMetadata: "all",
        });
      }
      const contexto = (resultados.matches || [])
        .filter(m => m.score > 0.2 && String(m.metadata?.usuario_id) === String(usuario.usuario_id))
        .slice(0, 5)
        .map(m => m.metadata?.text || "")
        .filter(Boolean)
        .join("\n---\n");
      return json({ ok: true, contexto, matches: resultados.matches?.length || 0 });
    } catch (e) {
      return err("Erro na busca: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: FETCH URL
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/fetch-url" && request.method === "POST") {
    try {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);

      const { url } = await request.json();
      if (!url || typeof url !== "string") return err("URL inválida.");

      const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
      if (ytMatch) {
        const videoId = ytMatch[1];
        let titulo = "", canal = "";
        try {
          const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
          if (oembed.ok) {
            const d = await oembed.json();
            titulo = d.title || "";
            canal = d.author_name || "";
          }
        } catch(_) {}

        let transcricao = "";
        try {
          const ytPage = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: { "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8", "User-Agent": "Mozilla/5.0 (compatible)" }
          });
          const html = await ytPage.text();
          const captionMatch = html.match(/"captionTracks":\[.*?"baseUrl":"([^"]+)"/);
          if (captionMatch) {
            const captionUrl = decodeURIComponent(captionMatch[1].replace(/\\u0026/g, "&"));
            const captRes = await fetch(captionUrl + "&fmt=json3");
            if (captRes.ok) {
              const captJson = await captRes.json();
              const eventos = captJson?.events || [];
              transcricao = eventos
                .filter(e => e.segs)
                .map(e => e.segs.map(s => s.utf8 || "").join(""))
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 80000);
            }
          }
        } catch(_) {}

        if (!titulo && !transcricao) return err("Não foi possível extrair informações deste vídeo.");

        const conteudo = [
          titulo ? `📺 Título: ${titulo}` : "",
          canal ? `👤 Canal: ${canal}` : "",
          transcricao ? `\n📝 Transcrição:\n${transcricao}` : "\n⚠️ Transcrição não disponível."
        ].filter(Boolean).join("\n");

        return json({ ok: true, tipo: "youtube", titulo, canal, conteudo, temTranscricao: !!transcricao });
      }

      let respFetch;
      try {
        respFetch = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AtriaAI/1.0)",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
          },
          redirect: "follow",
          signal: AbortSignal.timeout(8000)
        });
      } catch(e) {
        return err("Não foi possível acessar o site.");
      }

      if (!respFetch.ok) return err(`Site retornou erro ${respFetch.status}.`);

      const contentType = respFetch.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        return err("Este tipo de arquivo não pode ser lido como página web.");
      }

      const html = await respFetch.text();
      const tituloMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
      const tituloPagina = tituloMatch ? tituloMatch[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim() : "";

      let texto = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<header[\s\S]*?<\/header>/gi, "")
        .replace(/<aside[\s\S]*?<\/aside>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#\d+;/g," ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 80000);

      if (texto.length < 100) return err("Não foi possível extrair conteúdo desta página.");

      const conteudo = [
        tituloPagina ? `🌐 Página: ${tituloPagina}` : `🌐 URL: ${url}`,
        `\n${texto}`
      ].join("\n");

      return json({ ok: true, tipo: "site", titulo: tituloPagina, conteudo });

    } catch(e) {
      return err("Erro ao processar URL: " + e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: BRAIN STATUS
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/brain/status" && request.method === "GET") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    return json({
      ok: true,
      has_brain: !!usuario.has_brain,
      brain_status: usuario.brain_status || "inactive",
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTA: CHAT
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/chat" && request.method === "POST") {
    try {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);

      const { mensagem, chat_id: chat_id_param, imagem, tipo, urlConteudo, persona } = await request.json();
      if (!mensagem || mensagem.trim().length === 0) return err("Mensagem vazia.");
      if (mensagem.length > 50000) return err("Mensagem muito longa. Máximo 50.000 caracteres.");

      const _temImagem = !!(imagem && imagem.base64 && imagem.mediaType);
      const _temUrl = !!(urlConteudo && urlConteudo.length > 0);
      const _ehApres = tipo === "apresentacao" || /apresenta[çc][aã]o|apresentar|slides?|powerpoint|pptx|pitch\s?deck/i.test(mensagem);
      const _ehCodigo = tipo === "codigo" || /cri(e|a|ar)\s+(um\s+)?(site|p[áa]gina|componente|script|programa|bot[aã]o|sistema|aplicat|app|calculadora|formul|tabela|dashboard)|fa[çc]a\s+(um\s+)?(site|p[áa]gina|script|sistema)|escreva?\s+(um\s+)?(c[oó]digo|script|programa)|html\s+completo|c[oó]digo\s+(completo|em\s+(python|javascript|html|sql))|arquivo\s+html|em\s+python|em\s+javascript/i.test(mensagem);
      const _temAnexo = /arquivo\s+anexado|conte[úu]do\s+do\s+arquivo|```/.test(mensagem);
      const _pedeAnalise = /anali[sz]|estrat[eé]g|plano\s+de|c[áa]lculo|lucro|financeiro|resolva|por\s+que|diagn[oó]stico|swot|planejamento|projeç|avali[ae]|fluxo\s+de\s+caixa|margem|roi|kpi|otimiz/i.test(mensagem);
      const _plano = usuario.plano || "gratuito";
      let _modeloPrev;
      if (_temImagem || _ehApres || _ehCodigo || _temAnexo) _modeloPrev = "haiku";
      else if (_pedeAnalise || mensagem.length > 400) _modeloPrev = _plano === "elite" ? "opus" : _plano === "pro" ? "sonnet" : "deepseek";
      else _modeloPrev = "llama";

      const cota = await verificarCotaDiaria(usuario, env.DB, _modeloPrev, { temImagem: _temImagem, pedeArtefato: _ehApres || _ehCodigo });
      if (!cota.ok) return err(cota.erro, 429);

      let chat_id = chat_id_param ? parseInt(chat_id_param) : null;
      if (chat_id) {
        const chat = await env.DB.prepare("SELECT id FROM chats WHERE id = ? AND usuario_id = ?").bind(chat_id, usuario.usuario_id).first();
        if (!chat) chat_id = null;
      }
      if (!chat_id) {
        const novo = await env.DB.prepare("INSERT INTO chats (usuario_id, titulo) VALUES (?, 'Nova conversa')").bind(usuario.usuario_id).run();
        chat_id = novo.meta.last_row_id;
      }

      const historico = await env.DB.prepare(
        "SELECT role, conteudo FROM conversas WHERE usuario_id = ? AND chat_id = ? ORDER BY criado_em DESC LIMIT 20"
      ).bind(usuario.usuario_id, chat_id).all();

      const LIMITE_TOKENS_CONTEXTO = 12000;
      const estimarTokens = (texto) => Math.ceil((typeof texto === "string" ? texto : JSON.stringify(texto)).length / 4);
      let tokensTotais = estimarTokens(mensagem);
      const msgsFiltradas = [];
      const FRASES_RUINS = ["não consigo visualizar", "não consigo ver imagens", "não tenho acesso a imagens", "não é possível visualizar imagens", "não posso ver imagens", "infelizmente não consigo"];
      for (const m of (historico.results || [])) {
        if (m.role === "assistant" && FRASES_RUINS.some(f => m.conteudo?.toLowerCase().includes(f))) continue;
        const t = estimarTokens(m.conteudo);
        if (tokensTotais + t > LIMITE_TOKENS_CONTEXTO) break;
        msgsFiltradas.unshift({ role: m.role, content: m.conteudo });
        tokensTotais += t;
      }
      const msgs_historico = msgsFiltradas;

      const planoUsuario = usuario.plano || "gratuito";
      const temImagem = _temImagem;
      const ehApresentacao = _ehApres;
      const ehCodigo = _ehCodigo;
      const pedeArtefato = ehApresentacao || ehCodigo;
      const temAnexoDoc = _temAnexo;
      const pedeAnalise = _pedeAnalise;
      const mensagemLonga = mensagem.length > 400;

      const PLANOS_BUSCA = ["gratuito", "start", "pro", "elite"];
      const temBuscaWeb = PLANOS_BUSCA.includes(planoUsuario) && !pedeArtefato && !temImagem && KEYWORDS_BUSCA_WEB.test(mensagem);
      const WEB_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 3,
        user_location: { type: "approximate", country: "BR", city: "Brasil", timezone: "America/Sao_Paulo" } };

      let modelo_escolhido;
      if (planoUsuario === "elite") {
        if (temImagem || pedeArtefato || temAnexoDoc) modelo_escolhido = "haiku";
        else if (temBuscaWeb) modelo_escolhido = "haiku";
        else if (pedeAnalise || mensagemLonga) modelo_escolhido = "opus";
        else modelo_escolhido = "haiku";
      } else if (planoUsuario === "pro") {
        if (temImagem || pedeArtefato || temAnexoDoc) modelo_escolhido = "haiku";
        else if (temBuscaWeb) modelo_escolhido = "haiku";
        else if (pedeAnalise || mensagemLonga) modelo_escolhido = "sonnet";
        else modelo_escolhido = "haiku";
      } else if (planoUsuario === "start") {
        if (temImagem || pedeArtefato || temAnexoDoc) modelo_escolhido = "haiku";
        else if (pedeAnalise || mensagemLonga) modelo_escolhido = "deepseek";
        else if (temBuscaWeb) modelo_escolhido = "haiku";
        else modelo_escolhido = "deepseek";
      } else {
        if (temBuscaWeb) modelo_escolhido = "haiku";
        else if (pedeAnalise || mensagemLonga) modelo_escolhido = "deepseek";
        else modelo_escolhido = "llama";
      }

      let contextoCerebro = "";

      if (usuario.has_brain && usuario.brain_status === "active" && !temImagem && !pedeArtefato) {
        try {
          const embQ = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [mensagem] });
          let resV;
          try {
            resV = await env.VECTORIZE.query(embQ.data[0], {
              topK: 8,
              returnValues: false,
              returnMetadata: "all",
              filter: { usuario_id: String(usuario.usuario_id) },
            });
          } catch(filterErr) {
            resV = await env.VECTORIZE.query(embQ.data[0], {
              topK: 10,
              returnValues: false,
              returnMetadata: "all",
            });
          }

          const matches = (resV.matches || [])
            .filter(m => m.score > 0.2 && String(m.metadata?.usuario_id) === String(usuario.usuario_id))
            .slice(0, 4);

          const textoChunks = await Promise.all(matches.map(async m => {
            if (m.metadata?.text) return m.metadata.text;
            if (m.metadata?.r2_chunk_key && env.BRAIN_FILES) {
              const obj = await env.BRAIN_FILES.get(m.metadata.r2_chunk_key).catch(() => null);
              return obj ? await obj.text() : "";
            }
            return "";
          }));

          contextoCerebro = textoChunks.filter(Boolean).join("\n---\n").slice(0, 8000);
        } catch(e) {}
      }

      const personaSystem = persona && PERSONAS[persona] ? `\n\n🎭 MODO ATIVO: ${PERSONAS[persona]}` : "";

      const SYSTEM_FINAL = contextoCerebro
        ? `${SYSTEM_BASE}${personaSystem}\n\n🧠 Base de conhecimento do usuário (Cérebro):\n${contextoCerebro}\n\nUse esse contexto para enriquecer suas respostas quando relevante.`
        : `${SYSTEM_BASE}${personaSystem}`;

      const SYSTEM_PROMPT_APRESENTACAO_FINAL = contextoCerebro
        ? `${SYSTEM_PROMPT_APRESENTACAO}\n\n🧠 Base de conhecimento do usuário:\n${contextoCerebro}`
        : SYSTEM_PROMPT_APRESENTACAO;
      const SYSTEM_PROMPT_CODIGO_FINAL = SYSTEM_PROMPT_CODIGO;

      let msgAtual;
      if (temImagem) {
        msgAtual = { role: "user", content: [
          { type: "image", source: { type: "base64", media_type: imagem.mediaType, data: imagem.base64 } },
          { type: "text", text: mensagem }
        ]};
      } else if (urlConteudo) {
        const urlTruncado = urlConteudo.slice(0, 12000);
        msgAtual = { role: "user", content: `${urlTruncado}\n\n---\nPergunta do usuário: ${mensagem}` };
      } else {
        msgAtual = { role: "user", content: mensagem };
      }
      msgs_historico.push(msgAtual);

      let resposta, tokens_entrada, tokens_saida, tokens_total, modelo_usado;
      let artefato = null;

      if (modelo_escolhido === "haiku") {
        modelo_usado = "haiku";
        let systemPrompt = SYSTEM_FINAL;
        let maxTokens = 1500;
        if (ehApresentacao) { systemPrompt = SYSTEM_PROMPT_APRESENTACAO_FINAL; maxTokens = 4000; }
        else if (ehCodigo) { systemPrompt = SYSTEM_PROMPT_CODIGO_FINAL; maxTokens = 4000; }
        const bodyHaiku = { model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, system: systemPrompt, messages: msgs_historico };
        if (temBuscaWeb && !ehApresentacao && !ehCodigo) bodyHaiku.tools = [WEB_TOOL];

        if (!ehApresentacao && !ehCodigo && !temBuscaWeb) {
          bodyHaiku.stream = true;
          const respStream = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
            body: JSON.stringify(bodyHaiku),
          });
          if (!respStream.ok) return err("Erro na IA", 500);

          let respostaCompleta = "", tokensE = 0, tokensS = 0;
          const decoder = new TextDecoder();
          const { readable, writable } = new TransformStream({
            transform(chunk, controller) {
              const text = decoder.decode(chunk, { stream: true });
              for (const line of text.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (!raw || raw === '[DONE]') continue;
                try {
                  const ev = JSON.parse(raw);
                  if (ev.type === 'message_start') tokensE = ev.message?.usage?.input_tokens || 0;
                  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') respostaCompleta += ev.delta.text;
                  if (ev.type === 'message_delta') tokensS = ev.usage?.output_tokens || 0;
                } catch(e) {}
              }
              controller.enqueue(chunk);
            },
          });

          const pipePromise = respStream.body.pipeTo(writable).then(async () => {
            const total = tokensE + tokensS;
            try {
              await env.DB.prepare("INSERT INTO conversas (usuario_id, chat_id, role, conteudo, tokens) VALUES (?, ?, 'user', ?, ?)").bind(usuario.usuario_id, chat_id, mensagem, tokensE).run();
              await env.DB.prepare("INSERT INTO conversas (usuario_id, chat_id, role, conteudo, tokens) VALUES (?, ?, 'assistant', ?, ?)").bind(usuario.usuario_id, chat_id, respostaCompleta, tokensS).run();
              await env.DB.prepare("UPDATE chats SET atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(chat_id).run();
              const cont = await env.DB.prepare("SELECT COUNT(*) as total FROM conversas WHERE chat_id = ? AND role = 'user'").bind(chat_id).first();
              if (cont?.total === 1) await env.DB.prepare("UPDATE chats SET titulo = ? WHERE id = ?").bind(mensagem.slice(0, 60).replace(/\n/g, " ").trim(), chat_id).run();
              await env.DB.prepare("UPDATE usuarios SET tokens_usados = tokens_usados + ?, perguntas_hoje = perguntas_hoje + 1 WHERE id = ?").bind(total, usuario.usuario_id).run();
            } catch(e) { console.error("Stream DB error:", e); }
          });

          ctx.waitUntil(pipePromise);
          return new Response(readable, {
            headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
              "X-Chat-Id": String(chat_id), "X-Perguntas-Hoje": String((usuario.perguntas_hoje || 0) + 1) },
          });
        }

        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify(bodyHaiku),
        });
        const data = await resp.json();
        if (data.error) return err("Erro na IA: " + data.error.message, 500);
        tokens_entrada = data.usage?.input_tokens || 0;
        tokens_saida = data.usage?.output_tokens || 0;
        tokens_total = tokens_entrada + tokens_saida;
        const rawText = extrairTextoResposta(data.content);
        const usouBusca = data.content?.some(b => b.type === "tool_use" && b.name === "web_search");
        if (ehApresentacao || ehCodigo) {
          try {
            const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
            if (ehApresentacao) {
              artefato = { tipo: "apresentacao", titulo: parsed.titulo, slides: parsed.slides };
              resposta = `✅ Apresentação **"${parsed.titulo}"** criada com ${parsed.slides.length} slides!\n\n${parsed.resumo}`;
            } else {
              artefato = { tipo: "codigo", titulo: parsed.titulo, linguagem: parsed.linguagem, codigo: parsed.codigo };
              resposta = `✅ **${parsed.titulo}** criado!\n\n${parsed.resumo}`;
            }
          } catch(e) { resposta = rawText; }
        } else {
          resposta = rawText;
          if (usouBusca) resposta = "🔍 *Busca web realizada*\n\n" + resposta;
        }

      } else if (modelo_escolhido === "deepseek") {
        modelo_usado = "deepseek";
        const msgsDeepSeek = msgs_historico.filter(m => typeof m.content === "string").map(m => ({ role: m.role, content: m.content }));
        const dsResp = await env.AI.run("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", {
          messages: [{ role: "system", content: SYSTEM_FINAL }, ...msgsDeepSeek],
          max_tokens: 2000,
        });
        resposta = dsResp.response || dsResp?.choices?.[0]?.message?.content || "Sem resposta.";
        resposta = resposta.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        tokens_entrada = Math.ceil(mensagem.length / 4);
        tokens_saida = Math.ceil(resposta.length / 4);
        tokens_total = tokens_entrada + tokens_saida;
        if ((planoUsuario === "start" || planoUsuario === "gratuito") && pedeAnalise) {
          resposta += "\n\n---\n💡 **Quer uma análise mais profunda?** Disponível no [Plano Pro](https://ai.atriapay.com.br/#planos).";
        }

      } else if (modelo_escolhido === "sonnet") {
        modelo_usado = "sonnet";
        const bodySonnet = { model: "claude-sonnet-4-5", max_tokens: 2000, system: SYSTEM_FINAL, messages: msgs_historico.filter(m => typeof m.content === "string") };
        if (temBuscaWeb) bodySonnet.tools = [WEB_TOOL];
        const respSonnet = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify(bodySonnet),
        });
        const dataSonnet = await respSonnet.json();
        if (dataSonnet.error) return err("Erro na IA: " + dataSonnet.error.message, 500);
        const usouBuscaSonnet = dataSonnet.content?.some(b => b.type === "tool_use" && b.name === "web_search");
        resposta = extrairTextoResposta(dataSonnet.content);
        if (usouBuscaSonnet) resposta = "🔍 *Busca web realizada*\n\n" + resposta;
        tokens_entrada = dataSonnet.usage?.input_tokens || 0;
        tokens_saida = dataSonnet.usage?.output_tokens || 0;
        tokens_total = tokens_entrada + tokens_saida;

      } else if (modelo_escolhido === "opus") {
        modelo_usado = "opus";
        const usarThinking = pedeAnalise && mensagem.length > 800;
        const bodyOpus = {
          model: "claude-opus-4-5",
          max_tokens: usarThinking ? 6000 : 2500,
          system: SYSTEM_FINAL,
          messages: msgs_historico.filter(m => typeof m.content === "string"),
        };
        if (usarThinking) {
          bodyOpus.thinking = { type: "enabled", budget_tokens: 3000 };
        }
        if (temBuscaWeb && !usarThinking) bodyOpus.tools = [WEB_TOOL];
        const respOpus = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "interleaved-thinking-2025-05-14", "Content-Type": "application/json" },
          body: JSON.stringify(bodyOpus),
        });
        const dataOpus = await respOpus.json();
        if (dataOpus.error) return err("Erro na IA: " + dataOpus.error.message, 500);
        const usouBuscaOpus = dataOpus.content?.some(b => b.type === "tool_use" && b.name === "web_search");
        resposta = extrairTextoResposta(dataOpus.content);
        if (usouBuscaOpus) resposta = "🔍 *Busca web realizada*\n\n" + resposta;
        tokens_entrada = dataOpus.usage?.input_tokens || 0;
        tokens_saida = dataOpus.usage?.output_tokens || 0;
        tokens_total = tokens_entrada + tokens_saida;

      } else {
        modelo_usado = "llama";
        const msgsLlama = msgs_historico.filter(m => typeof m.content === "string").map(m => ({ role: m.role, content: m.content }));
        const llamaResp = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
          messages: [{ role: "system", content: SYSTEM_FINAL }, ...msgsLlama],
          max_tokens: 1500,
        });
        resposta = llamaResp.response || llamaResp?.choices?.[0]?.message?.content || "Sem resposta.";
        tokens_entrada = Math.ceil(mensagem.length / 4);
        tokens_saida = Math.ceil(resposta.length / 4);
        tokens_total = tokens_entrada + tokens_saida;
      }

      await env.DB.prepare("INSERT INTO conversas (usuario_id, chat_id, role, conteudo, tokens) VALUES (?, ?, 'user', ?, ?)").bind(usuario.usuario_id, chat_id, mensagem, tokens_entrada).run();
      await env.DB.prepare("INSERT INTO conversas (usuario_id, chat_id, role, conteudo, tokens) VALUES (?, ?, 'assistant', ?, ?)").bind(usuario.usuario_id, chat_id, resposta, tokens_saida).run();
      await env.DB.prepare("UPDATE chats SET atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(chat_id).run();

      const contagem = await env.DB.prepare("SELECT COUNT(*) as total FROM conversas WHERE chat_id = ? AND role = 'user'").bind(chat_id).first();
      if (contagem?.total === 1) {
        const titulo = mensagem.slice(0, 60).replace(/\n/g, " ").trim();
        await env.DB.prepare("UPDATE chats SET titulo = ? WHERE id = ?").bind(titulo, chat_id).run();
      }

      await env.DB.prepare("UPDATE usuarios SET tokens_usados = tokens_usados + ?, perguntas_hoje = perguntas_hoje + 1 WHERE id = ?").bind(tokens_total, usuario.usuario_id).run();

      return json({
        ok: true,
        resposta,
        chat_id,
        tokens_usados: tokens_total,
        perguntas_hoje: usuario.perguntas_hoje + 1,
        modelo: modelo_usado,
        artefato,
        cerebro_ativo: !!(usuario.has_brain && usuario.brain_status === "active"),
        cerebro_usado: contextoCerebro.length > 0,
      });

    } catch (e) {
      return err("Erro interno: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTAS DE SUPORTE
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/suporte-publico" && request.method === "POST") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autorizado", 401);
    try {
      const { mensagens } = await request.json();
      if (!mensagens || !mensagens.length) return err("Mensagens vazias");
      const historico = mensagens.slice(-10);
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, system: SUPORTE_PUBLICO_SYSTEM, messages: historico }),
      });
      const data = await resp.json();
      if (data.error) return err("Erro IA: " + data.error.message, 500);
      const resposta = data.content?.find(b => b.type === "text")?.text || "";
      return json({ ok: true, resposta });
    } catch(e) {
      return err("Erro interno: " + e.message, 500);
    }
  }

  if (path === "/suporte-leads" && request.method === "POST") {
    try {
      const { mensagens } = await request.json();
      if (!mensagens || !mensagens.length) return err("Mensagens vazias");
      const historico = mensagens.slice(-10);
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, system: SUPORTE_LEADS_SYSTEM, messages: historico }),
      });
      const data = await resp.json();
      if (data.error) return err("Erro IA: " + data.error.message, 500);
      const resposta = data.content?.find(b => b.type === "text")?.text || "";
      return json({ ok: true, resposta });
    } catch(e) {
      return err("Erro interno: " + e.message, 500);
    }
  }

  if (path === "/suporte-admin" && request.method === "POST") {
    const adminKey = request.headers.get("x-admin-key");
    if (adminKey !== env.ADMIN_KEY) return err("Não autorizado", 401);
    try {
      const { mensagens } = await request.json();
      if (!mensagens || !mensagens.length) return err("Mensagens vazias");
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, system: SUPORTE_ADMIN_SYSTEM, messages: mensagens }),
      });
      const data = await resp.json();
      if (data.error) return err("Erro IA: " + data.error.message, 500);
      const resposta = data.content?.find(b => b.type === "text")?.text || "";
      return json({ ok: true, resposta });
    } catch(e) {
      return err("Erro interno: " + e.message, 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTAS PÚBLICAS
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/stats-publico" && request.method === "GET") {
    const [assinantes] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as total FROM usuarios WHERE plano != 'gratuito' AND ativo = 1").first(),
    ]);
    const total_assinantes = assinantes?.total || 0;
    return json({
      ok: true,
      assinantes_ativos: total_assinantes,
      arvores_preservadas: total_assinantes * 3,
    });
  }

  if (path === "/indicacoes" && request.method === "GET") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    let ref_code = null, indicacoes_convertidas = 0, indicados = [];
    try {
      const extra = await env.DB.prepare("SELECT ref_code, indicacoes_convertidas FROM usuarios WHERE id = ?").bind(usuario.usuario_id).first();
      ref_code = extra?.ref_code || null;
      indicacoes_convertidas = extra?.indicacoes_convertidas || 0;
      if (!ref_code) {
        ref_code = gerarRefCode();
        await env.DB.prepare("UPDATE usuarios SET ref_code = ? WHERE id = ?").bind(ref_code, usuario.usuario_id).run().catch(() => {});
      }
    } catch(e) {
      ref_code = usuario.usuario_id.toString(16).toUpperCase().padStart(8, "0");
    }
    try {
      const res = await env.DB.prepare("SELECT nome, plano, criado_em FROM usuarios WHERE indicado_por = ? ORDER BY criado_em DESC LIMIT 50").bind(usuario.usuario_id).all();
      indicados = res.results || [];
    } catch(e) {}
    return json({
      ok: true,
      ref_code,
      link: `https://ai.atriapay.com.br/?ref=${ref_code}`,
      indicacoes_convertidas,
      tokens_ganhos: indicacoes_convertidas * 200000,
      indicados,
    });
  }

  if (path === "/historico" && request.method === "GET") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    const historico = await env.DB.prepare("SELECT role, conteudo, criado_em FROM conversas WHERE usuario_id = ? ORDER BY criado_em ASC LIMIT 50").bind(usuario.usuario_id).all();
    return json({ ok: true, mensagens: historico.results || [] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTAS DE PAGAMENTO
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/criar-pagamento" && request.method === "POST") {
    try {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);
      const { plano } = await request.json();
      const planos = {
        start: { titulo: "Atria AI — Plano Start", preco: 47, tokens: 500000 },
        pro: { titulo: "Atria AI — Plano Pro", preco: 97, tokens: 1000000 },
        elite: { titulo: "Atria AI — Plano Elite", preco: 299, tokens: 2000000 },
      };
      if (!planos[plano]) return err("Plano inválido.");
      const p = planos[plano];
      const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ title: p.titulo, quantity: 1, unit_price: p.preco, currency_id: "BRL" }],
          external_reference: `${usuario.usuario_id}|${plano}`,
          back_urls: { success: "https://ai.atriapay.com.br/chat?pagamento=sucesso", failure: "https://ai.atriapay.com.br/chat?pagamento=falhou", pending: "https://ai.atriapay.com.br/chat?pagamento=pendente" },
          auto_return: "approved",
          payment_methods: { excluded_payment_types: [], installments: 1 },
        }),
      });
      const mpData = await mpRes.json();
      if (!mpData.init_point) return err("Erro ao criar pagamento: " + JSON.stringify(mpData), 500);
      return json({ ok: true, url: mpData.init_point });
    } catch (e) { return err("Erro interno: " + e.message, 500); }
  }

  if (path === "/comprar-creditos" && request.method === "POST") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    try {
      const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ title: "Atria AI — Pacote de Créditos 200k tokens", quantity: 1, unit_price: 20, currency_id: "BRL" }],
          external_reference: `${usuario.usuario_id}|creditos`,
          back_urls: { success: "https://ai.atriapay.com.br/chat?pagamento=creditos", failure: "https://ai.atriapay.com.br/chat?pagamento=falhou", pending: "https://ai.atriapay.com.br/chat?pagamento=pendente" },
          auto_return: "approved",
          payment_methods: { installments: 1 },
        }),
      });
      const mpData = await mpRes.json();
      if (!mpData.init_point) return err("Erro ao criar pagamento.", 500);
      return json({ ok: true, url: mpData.init_point });
    } catch (e) { return err("Erro interno: " + e.message, 500); }
  }

  if (path === "/comprar-cerebro" && request.method === "POST") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    if (usuario.has_brain && usuario.brain_status === "active") {
      return err("Módulo Cérebro já está ativo na sua conta.", 400);
    }
    try {
      const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ title: "Atria AI — Módulo Cérebro (Memória Infinita)", quantity: 1, unit_price: 9.99, currency_id: "BRL" }],
          external_reference: `${usuario.usuario_id}|cerebro`,
          back_urls: {
            success: "https://ai.atriapay.com.br/chat?pagamento=cerebro",
            failure: "https://ai.atriapay.com.br/chat?pagamento=falhou",
            pending: "https://ai.atriapay.com.br/chat?pagamento=pendente",
          },
          auto_return: "approved",
          payment_methods: { installments: 1 },
        }),
      });
      const mpData = await mpRes.json();
      if (!mpData.init_point) return err("Erro ao criar pagamento: " + JSON.stringify(mpData), 500);
      return json({ ok: true, url: mpData.init_point });
    } catch (e) { return err("Erro interno: " + e.message, 500); }
  }

  if (path === "/planos" && request.method === "GET") {
    return json({ ok: true, planos: [
      { id: "start", nome: "Start", preco: 47, tokens: 500000, link: "https://mpago.la/1hfW7Sf" },
      { id: "pro", nome: "Pro", preco: 97, tokens: 1000000, link: "https://mpago.la/2HxT9Bn" },
      { id: "elite", nome: "Elite", preco: 299, tokens: 2000000, link: "https://mpago.la/2DES7wN" },
    ]});
  }

  // ═══════════════════════════════════════════════════════════════════
  // WEBHOOKS
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/webhook/mp" && request.method === "POST") {
    try {
      const body = await request.json();
      if (body.type !== "payment") return json({ ok: true });
      const payment_id = body.data?.id;
      if (!payment_id) return json({ ok: true });
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
        headers: { "Authorization": `Bearer ${env.MP_ACCESS_TOKEN}` },
      });
      const pagamento = await mpRes.json();
      if (pagamento.status !== "approved") return json({ ok: true });
      const external_reference = pagamento.external_reference || "";
      const [usuario_id_str, plano_ref] = external_reference.split("|");
      const usuario_id = parseInt(usuario_id_str);
      const planos_config = {
        start: { tokens_limite: 500000 },
        pro: { tokens_limite: 1000000 },
        elite: { tokens_limite: 2000000 },
        creditos: { tokens_adicionar: 200000 },
        cerebro: { brain: true },
      };
      let plano = plano_ref;
      if (!planos_config[plano]) {
        const valor = pagamento.transaction_amount;
        if (valor >= 299) plano = "elite";
        else if (valor >= 97) plano = "pro";
        else if (valor >= 47) plano = "start";
        else if (valor >= 20) plano = "creditos";
        else if (valor >= 9.99 && valor < 20) plano = "atria_voice";
        else return json({ ok: true });
      }
      const email = pagamento.payer?.email?.toLowerCase().trim();
      let uid = usuario_id || null;
      if (!uid && email) {
        const u = await env.DB.prepare("SELECT id FROM usuarios WHERE email = ?").bind(email).first();
        uid = u?.id || null;
      }
      if (!uid) return json({ ok: true });
      if (plano === "atria_voice") {
        await env.DB.prepare("UPDATE usuarios SET has_atria_voice = 1 WHERE id = ?").bind(uid).run();
      } else if (plano === "cerebro") {
        await env.DB.prepare("UPDATE usuarios SET has_brain = 1, brain_status = 'active' WHERE id = ?").bind(uid).run();
      } else if (plano === "creditos") {
        await env.DB.prepare("UPDATE usuarios SET tokens_limite = tokens_limite + 200000 WHERE id = ?").bind(uid).run();
        await env.DB.prepare("INSERT INTO creditos (usuario_id, tokens, origem) VALUES (?, ?, ?)").bind(uid, 200000, `mp_avulso_${payment_id}`).run();
      } else {
        const tokens_limite = planos_config[plano]?.tokens_limite;
        if (!tokens_limite) return json({ ok: true });
        await env.DB.prepare("UPDATE usuarios SET plano = ?, tokens_limite = ?, tokens_usados = 0 WHERE id = ?").bind(plano, tokens_limite, uid).run();
        await env.DB.prepare("INSERT INTO creditos (usuario_id, tokens, origem) VALUES (?, ?, ?)").bind(uid, tokens_limite, `mp_payment_${payment_id}`).run();
        await premiarIndicador(uid, env.DB);
      }
      return json({ ok: true });
    } catch (e) { return json({ ok: true }); }
  }

  if (path === "/webhook/kiwify" && request.method === "POST") {
    try {
      const body = await request.json();
      const kiwify_token = env.KIWIFY_WEBHOOK_TOKEN;
      if (kiwify_token && body.token !== kiwify_token) return new Response("Unauthorized", { status: 401 });
      const evento = body.webhook_event_type || body.order_status || "";
      const email = body.Customer?.email?.toLowerCase().trim();
      const nome = body.Customer?.full_name || "";
      const produto = body.Product?.name || "";
      const order_id = body.order_id || "";
      const cupom = body.Commissions?.[0]?.code || body.coupon_code || "";
      if (!email) return json({ ok: true });
      const planos_config = {
        start: { tokens_limite: 500000 },
        pro: { tokens_limite: 1000000 },
        elite: { tokens_limite: 2000000 },
      };
      function detectarPlano(nomeProduto) {
        const n = nomeProduto.toLowerCase();
        if (n.includes("elite")) return "elite";
        if (n.includes("pro")) return "pro";
        if (n.includes("start")) return "start";
        if (n.includes("cerebro") || n.includes("cérebro") || n.includes("brain")) return "cerebro";
        return null;
      }
      let usuario = await env.DB.prepare("SELECT id, plano FROM usuarios WHERE email = ?").bind(email).first();
      if (evento === "compra_aprovada" || evento === "order_approved" || evento === "subscription_renewed") {
        const plano = detectarPlano(produto);
        if (!plano) return json({ ok: true });
        if (plano === "cerebro") {
          if (usuario) await env.DB.prepare("UPDATE usuarios SET has_brain = 1, brain_status = 'active' WHERE email = ?").bind(email).run();
        } else {
          const cfg = planos_config[plano];
          if (!usuario) {
            const nomes = nome.split(" ");
            const fname = nomes[0] || "Usuário";
            const lname = nomes.slice(1).join(" ") || "";
            const senha_hash = await hashSenha(Math.random().toString(36).slice(2, 10));
            const ref_code = gerarRefCode();
            const res = await env.DB.prepare(
              "INSERT INTO usuarios (nome, sobrenome, email, senha_hash, plano, tokens_limite, tokens_usados, ativo, ref_code) VALUES (?,?,?,?,?,?,0,1,?)"
            ).bind(fname, lname, email, senha_hash, plano, cfg.tokens_limite, ref_code).run();
            const novo_id = res.meta?.last_row_id;
            await env.DB.prepare("INSERT INTO creditos (usuario_id, tokens, origem) VALUES (?,?,?)").bind(novo_id, cfg.tokens_limite, `kiwify_${evento}_${order_id}`).run();
            await premiarIndicador(novo_id, env.DB);
          } else {
            await env.DB.prepare("UPDATE usuarios SET plano=?, tokens_limite=?, tokens_usados=0, ativo=1 WHERE email=?").bind(plano, cfg.tokens_limite, email).run();
            await env.DB.prepare("INSERT INTO creditos (usuario_id, tokens, origem) VALUES (?,?,?)").bind(usuario.id, cfg.tokens_limite, `kiwify_${evento}_${order_id}`).run();
            await premiarIndicador(usuario.id, env.DB);
          }
        }
        if (cupom) await env.DB.prepare("UPDATE usuarios SET cupom_origem=? WHERE email=?").bind(cupom.toUpperCase(), email).run().catch(() => {});
      } else if (evento === "subscription_canceled" || evento === "compra_reembolsada" || evento === "order_refunded") {
        if (usuario) {
          const plano = detectarPlano(produto);
          if (plano === "cerebro") {
            await env.DB.prepare("UPDATE usuarios SET has_brain = 0, brain_status = 'inactive' WHERE email = ?").bind(email).run();
          } else {
            await env.DB.prepare("UPDATE usuarios SET plano='gratuito', tokens_limite=0, tokens_usados=0 WHERE email=?").bind(email).run();
          }
        }
      } else if (evento === "subscription_late") {
        if (usuario) await env.DB.prepare("UPDATE usuarios SET ativo=0 WHERE email=?").bind(email).run();
      }
      return json({ ok: true });
    } catch (e) { return json({ ok: true }); }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTAS DE CHATS
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/chats" && request.method === "GET") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    const busca = url.searchParams.get("q") || "";
    let chats;
    if (busca) {
      chats = await env.DB.prepare(`SELECT c.id, c.titulo, c.criado_em, c.atualizado_em, (SELECT conteudo FROM conversas WHERE chat_id = c.id AND role = 'user' ORDER BY criado_em ASC LIMIT 1) as primeira_msg FROM chats c WHERE c.usuario_id = ? AND (c.titulo LIKE ? OR EXISTS (SELECT 1 FROM conversas WHERE chat_id = c.id AND conteudo LIKE ?)) ORDER BY c.atualizado_em DESC LIMIT 50`).bind(usuario.usuario_id, `%${busca}%`, `%${busca}%`).all();
    } else {
      chats = await env.DB.prepare(`SELECT c.id, c.titulo, c.criado_em, c.atualizado_em, (SELECT conteudo FROM conversas WHERE chat_id = c.id AND role = 'user' ORDER BY criado_em ASC LIMIT 1) as primeira_msg FROM chats c WHERE c.usuario_id = ? ORDER BY c.atualizado_em DESC LIMIT 50`).bind(usuario.usuario_id).all();
    }
    return json({ ok: true, chats: chats.results || [] });
  }

  if (path === "/chats" && request.method === "POST") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    const result = await env.DB.prepare("INSERT INTO chats (usuario_id, titulo) VALUES (?, 'Nova conversa')").bind(usuario.usuario_id).run();
    return json({ ok: true, chat_id: result.meta.last_row_id });
  }

  if (path.match(/^\/chats\/\d+$/) && request.method === "PATCH") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    const chat_id = parseInt(path.split("/")[2]);
    const { titulo } = await request.json();
    if (!titulo?.trim()) return err("Título inválido.");
    await env.DB.prepare("UPDATE chats SET titulo = ? WHERE id = ? AND usuario_id = ?").bind(titulo.trim().slice(0, 80), chat_id, usuario.usuario_id).run();
    return json({ ok: true });
  }

  if (path.match(/^\/chats\/\d+$/) && request.method === "DELETE") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    const chat_id = parseInt(path.split("/")[2]);
    await env.DB.prepare("DELETE FROM conversas WHERE chat_id = ? AND usuario_id = ?").bind(chat_id, usuario.usuario_id).run();
    await env.DB.prepare("DELETE FROM chats WHERE id = ? AND usuario_id = ?").bind(chat_id, usuario.usuario_id).run();
    return json({ ok: true });
  }

  if (path.match(/^\/chats\/\d+\/mensagens$/) && request.method === "GET") {
    const usuario = await autenticar(request, env.DB);
    if (!usuario) return err("Não autenticado.", 401);
    const chat_id = parseInt(path.split("/")[2]);
    const chat = await env.DB.prepare("SELECT id FROM chats WHERE id = ? AND usuario_id = ?").bind(chat_id, usuario.usuario_id).first();
    if (!chat) return err("Chat não encontrado.", 404);
    const msgs = await env.DB.prepare("SELECT role, conteudo, criado_em FROM conversas WHERE chat_id = ? ORDER BY criado_em ASC").bind(chat_id).all();
    return json({ ok: true, mensagens: msgs.results || [] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ROTAS DE FEEDBACK E ADMIN
  // ═══════════════════════════════════════════════════════════════════

  if (path === "/feedback" && request.method === "POST") {
    try {
      const usuario = await autenticar(request, env.DB);
      if (!usuario) return err("Não autenticado.", 401);
      const { tipo, mensagem, avaliacao } = await request.json();
      if (!mensagem?.trim()) return err("Mensagem obrigatória.");
      const tiposValidos = ["sugestao", "reclamacao", "elogio"];
      const tipoFinal = tiposValidos.includes(tipo) ? tipo : "sugestao";
      await env.DB.prepare("INSERT INTO feedbacks (usuario_id, nome, email, tipo, mensagem, avaliacao) VALUES (?, ?, ?, ?, ?, ?)").bind(usuario.usuario_id, usuario.nome, usuario.email, tipoFinal, mensagem.trim(), avaliacao || null).run();
      return json({ ok: true });
    } catch (e) { return err("Erro interno: " + e.message, 500); }
  }

  if (path === "/admin/feedbacks" && request.method === "GET") {
    const adminKey = request.headers.get("x-admin-key");
    if (!adminKey || adminKey !== env.ADMIN_KEY) return err("Não autorizado.", 401);
    const tipo = url.searchParams.get("tipo") || "";
    let query = "SELECT f.*, u.nome, u.email FROM feedbacks f LEFT JOIN usuarios u ON f.usuario_id = u.id WHERE 1=1";
    const params = [];
    if (tipo) { query += " AND f.tipo = ?"; params.push(tipo); }
    query += " ORDER BY f.criado_em DESC LIMIT 100";
    const feedbacks = await env.DB.prepare(query).bind(...params).all();
    return json({ ok: true, feedbacks: feedbacks.results || [] });
  }

  if (path === "/admin/stats" && request.method === "GET") {
    const adminKey = request.headers.get("x-admin-key");
    if (!adminKey || adminKey !== env.ADMIN_KEY) return err("Não autorizado.", 401);
    const hoje = new Date().toISOString().slice(0, 10);
    const [totalUsuarios, usuariosHoje, totalMensagens, mensagensHoje, porPlano, maisAtivos, cadastrosRecentes, totalCerebro] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as total FROM usuarios").first(),
      env.DB.prepare("SELECT COUNT(*) as total FROM usuarios WHERE DATE(criado_em) = ?").bind(hoje).first(),
      env.DB.prepare("SELECT COUNT(*) as total FROM conversas").first(),
      env.DB.prepare("SELECT COUNT(*) as total FROM conversas WHERE DATE(criado_em) = ?").bind(hoje).first(),
      env.DB.prepare("SELECT plano, COUNT(*) as total FROM usuarios GROUP BY plano").all(),
      env.DB.prepare("SELECT u.nome, u.email, u.plano, u.has_brain, u.tokens_usados, u.perguntas_hoje, COUNT(c.id) as total_msgs FROM usuarios u LEFT JOIN conversas c ON c.usuario_id = u.id GROUP BY u.id ORDER BY total_msgs DESC LIMIT 10").all(),
      env.DB.prepare("SELECT id, nome, email, plano, has_brain, brain_status, tokens_usados, perguntas_hoje, criado_em FROM usuarios ORDER BY criado_em DESC LIMIT 20").all(),
      env.DB.prepare("SELECT COUNT(*) as total FROM usuarios WHERE has_brain = 1 AND brain_status = 'active'").first(),
    ]);
    const planosValor = { start: 47, pro: 97, elite: 299 };
    let receita = 0;
    (porPlano.results || []).forEach(r => { receita += (planosValor[r.plano] || 0) * r.total; });
    receita += (totalCerebro?.total || 0) * 9.99;
    return json({ ok: true, stats: {
      usuarios: { total: totalUsuarios?.total || 0, hoje: usuariosHoje?.total || 0, por_plano: porPlano.results || [] },
      conversas: { total_mensagens: totalMensagens?.total || 0, mensagens_hoje: mensagensHoje?.total || 0 },
      receita_mrr: receita,
      cerebro: { ativos: totalCerebro?.total || 0 },
      mais_ativos: maisAtivos.results || [],
      cadastros_recentes: cadastrosRecentes.results || [],
    }});
  }

  if (path === "/admin/usuarios" && request.method === "GET") {
    const adminKey = request.headers.get("x-admin-key");
    if (!adminKey || adminKey !== env.ADMIN_KEY) return err("Não autorizado.", 401);
    const busca = url.searchParams.get("q") || "";
    const plano = url.searchParams.get("plano") || "";
    let query = "SELECT id, nome, email, plano, has_brain, brain_status, indicacoes_convertidas, tokens_usados, tokens_limite, perguntas_hoje, ativo, criado_em FROM usuarios WHERE 1=1";
    const params = [];
    if (busca) { query += " AND (nome LIKE ? OR email LIKE ?)"; params.push(`%${busca}%`, `%${busca}%`); }
    if (plano) { query += " AND plano = ?"; params.push(plano); }
    query += " ORDER BY criado_em DESC LIMIT 100";
    const usuarios = await env.DB.prepare(query).bind(...params).all();
    return json({ ok: true, usuarios: usuarios.results || [] });
  }

  if (path.match(/^\/admin\/usuarios\/\d+$/) && request.method === "PATCH") {
    const adminKey = request.headers.get("x-admin-key");
    if (!adminKey || adminKey !== env.ADMIN_KEY) return err("Não autorizado.", 401);
    const uid = parseInt(path.split("/")[3]);
    const { plano, ativo, has_brain } = await request.json();
    const planos_tokens = { gratuito: 0, start: 500000, pro: 1000000, elite: 2000000 };
    if (plano) await env.DB.prepare("UPDATE usuarios SET plano = ?, tokens_limite = ?, tokens_usados = 0 WHERE id = ?").bind(plano, planos_tokens[plano] || 150000, uid).run();
    if (typeof ativo === "boolean") await env.DB.prepare("UPDATE usuarios SET ativo = ? WHERE id = ?").bind(ativo ? 1 : 0, uid).run();
    if (typeof has_brain === "boolean") await env.DB.prepare("UPDATE usuarios SET has_brain = ?, brain_status = ? WHERE id = ?").bind(has_brain ? 1 : 0, has_brain ? "active" : "inactive", uid).run();
    return json({ ok: true });
  }

  return err("Rota não encontrada.", 404);
}
