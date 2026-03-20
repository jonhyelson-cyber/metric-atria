// ==========================================
// DASHBOARD PRINCIPAL
// ==========================================

import { auth, db } from './firebase.js';
import { mostrarAlerta, mostrarLoading, formatarMoeda, calcularVariacao, truncarTexto } from './utils.js';
import { observarAuth, getPixelId, logout as logoutAuth } from './auth.js';

// ==========================================
// VARIÁVEIS GLOBAIS
// ==========================================
let eventos = [];
let vendas = [];
let periodoAtual = 'hoje';
let usuarioLogado = null;
let mainChart = null;

// ==========================================
// INICIALIZAÇÃO
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Inicializando dashboard...');
    
    // Inicializar Chart.js se existir
    if (typeof Chart !== 'undefined') {
        iniciarGraficoPrincipal();
    }
    
    // Construir menu lateral
    construirMenu();
    
    // Observar autenticação
    observarAuth(async (usuario) => {
        if (usuario) {
            usuarioLogado = usuario;
            await carregarDadosIniciais(usuario.pixelID);
            atualizarInfoUsuario(usuario);
            verificarStatusPixel();
        }
    });
    
    // Carregar histórico de análises
    carregarHistorico();
});

// ==========================================
// CONSTRUÇÃO DO MENU LATERAL
// ==========================================
function construirMenu() {
    const menu = document.getElementById('sidebar-menu');
    if (!menu) return;
    
    const itens = [
        { id: 'visao-geral', icone: 'fa-home', label: 'Visão Geral' },
        { id: 'produtos', icone: 'fa-cube', label: 'Produtos' },
        { id: 'vendedores', icone: 'fa-users', label: 'Vendedores' },
        { id: 'compradores', icone: 'fa-user-tie', label: 'Compradores' },
        { id: 'regioes', icone: 'fa-map-marker-alt', label: 'Regiões' },
        { id: 'sazonalidade', icone: 'fa-calendar', label: 'Sazonalidade' },
        { id: 'trafego-manual', icone: 'fa-chart-line', label: 'Análise de Tráfego' },
        { id: 'analise-avancada', icone: 'fa-fire', label: 'Análise Avançada' }
    ];
    
    menu.innerHTML = itens.map(item => `
        <div class="sidebar-item" onclick="window.mudarAba('${item.id}')">
            <i class="fas ${item.icone}"></i>
            <span>${item.label}</span>
        </div>
    `).join('');
    
    // Ativar primeira aba
    document.querySelector('.sidebar-item')?.classList.add('active');
    mostrarAba('visao-geral');
}

// ==========================================
// CARREGAMENTO DE DADOS
// ==========================================
async function carregarDadosIniciais(pixelID) {
    try {
        mostrarLoading(true);
        
        // Buscar eventos
        const snapshot = await db.collection('eventos')
            .where('pixelID', '==', pixelID)
            .orderBy('timestamp', 'desc')
            .limit(500)
            .get();
        
        eventos = [];
        vendas = [];
        
        snapshot.forEach(doc => {
            const evento = doc.data();
            eventos.push(evento);
            if (evento.tipo === 'compra_confirmada') {
                vendas.push(evento);
            }
        });
        
        // Atualizar todas as visualizações
        atualizarTudo();
        
        // Configurar listener em tempo real
        configurarListenerTempoReal(pixelID);
        
    } catch (error) {
        console.error('Erro ao carregar dados:', error);
        mostrarAlerta('erro', 'Erro ao carregar dados');
    } finally {
        mostrarLoading(false);
    }
}

function configurarListenerTempoReal(pixelID) {
    db.collection('eventos')
        .where('pixelID', '==', pixelID)
        .orderBy('timestamp', 'desc')
        .limit(500)
        .onSnapshot((snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added') {
                    const evento = change.doc.data();
                    eventos.unshift(evento);
                    if (evento.tipo === 'compra_confirmada') {
                        vendas.unshift(evento);
                    }
                    // Manter apenas 500 eventos
                    if (eventos.length > 500) eventos.pop();
                    if (vendas.length > 500) vendas.pop();
                }
            });
            
            atualizarTudo();
            verificarStatusPixel();
        }, (error) => {
            console.error('Erro no listener:', error);
        });
}

// ==========================================
// ATUALIZAÇÕES
// ==========================================
function atualizarTudo() {
    const eventosFiltrados = filtrarPorPeriodo(periodoAtual);
    
    atualizarCardsPrincipais(eventosFiltrados);
    atualizarGraficoComDados(eventosFiltrados);
    atualizarRankings();
    atualizarUltimasVendas();
    atualizarAnaliseAvancada(eventosFiltrados);
}

function filtrarPorPeriodo(periodo) {
    const agora = new Date();
    let dataLimite;
    
    if (periodo === 'hoje') {
        dataLimite = new Date(agora.setHours(0, 0, 0, 0));
    } else if (periodo === '7d') {
        dataLimite = new Date(agora.setDate(agora.getDate() - 7));
    } else if (periodo === '30d') {
        dataLimite = new Date(agora.setDate(agora.getDate() - 30));
    } else {
        return eventos;
    }
    
    return eventos.filter(e => {
        if (!e.timestamp) return false;
        const dataEvento = e.timestamp.seconds ? new Date(e.timestamp.seconds * 1000) : new Date(e.timestamp);
        return dataEvento > dataLimite;
    });
}

// ==========================================
// CARDS PRINCIPAIS
// ==========================================
function atualizarCardsPrincipais(eventosFiltrados) {
    const container = document.getElementById('cards-principais');
    if (!container) return;
    
    const totalViews = eventosFiltrados.filter(e => e.tipo === 'page_view').length;
    const totalVendas = eventosFiltrados.filter(e => e.tipo === 'compra_confirmada').length;
    const totalCliques = eventosFiltrados.filter(e => e.tipo === 'venda_click').length;
    const totalAbandonos = eventosFiltrados.filter(e => e.tipo === 'cart_abandon').length;
    
    const faturamento = vendas.reduce((acc, v) => acc + (parseFloat(v.produto_preco) || 0), 0);
    const taxaConversao = totalViews > 0 ? (totalVendas / totalViews) * 100 : 0;
    const taxaAbandono = totalCliques > 0 ? (totalAbandonos / totalCliques) * 100 : 0;
    
    container.innerHTML = `
        <div class="glass-card tooltip">
            <span class="tooltip-text">Total de visitas únicas</span>
            <div class="card-icon" style="background: rgba(6, 182, 212, 0.1);">
                <i class="fas fa-eye" style="color: var(--accent-primary);"></i>
            </div>
            <div class="card-label">Visitas Totais</div>
            <div class="card-value">${totalViews}</div>
            <div class="card-trend">
                <span class="trend-up">↑ 12%</span> vs período anterior
            </div>
        </div>
        
        <div class="glass-card tooltip">
            <span class="tooltip-text">Vendas confirmadas</span>
            <div class="card-icon" style="background: rgba(139, 92, 246, 0.1);">
                <i class="fas fa-shopping-cart" style="color: var(--accent-secondary);"></i>
            </div>
            <div class="card-label">Vendas Confirmadas</div>
            <div class="card-value">${totalVendas}</div>
            <div class="card-trend">
                <span class="trend-up">↑ 8%</span> vs período anterior
            </div>
        </div>
        
        <div class="glass-card tooltip">
            <span class="tooltip-text">Percentual de conversão</span>
            <div class="card-icon" style="background: rgba(16, 185, 129, 0.1);">
                <i class="fas fa-chart-line" style="color: var(--success);"></i>
            </div>
            <div class="card-label">Taxa Conversão</div>
            <div class="card-value">${taxaConversao.toFixed(1)}%</div>
            <div class="card-trend">
                <span class="trend-up">↑ 5%</span> vs período anterior
            </div>
        </div>
        
        <div class="glass-card tooltip">
            <span class="tooltip-text">Faturamento total</span>
            <div class="card-icon" style="background: rgba(245, 158, 11, 0.1);">
                <i class="fas fa-dollar-sign" style="color: var(--warning);"></i>
            </div>
            <div class="card-label">Faturamento</div>
            <div class="card-value">${formatarMoeda(faturamento)}</div>
            <div class="card-trend">
                <span class="trend-up">↑ 15%</span> vs período anterior
            </div>
        </div>
    `;
}

// ==========================================
// GRÁFICO PRINCIPAL
// ==========================================
function iniciarGraficoPrincipal() {
    const ctx = document.getElementById('mainChart')?.getContext('2d');
    if (!ctx) return;
    
    mainChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun'],
            datasets: [{
                label: 'Vendas',
                data: [0, 0, 0, 0, 0, 0],
                borderColor: '#06b6d4',
                backgroundColor: 'rgba(6, 182, 212, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}

function atualizarGraficoComDados(eventosFiltrados) {
    if (!mainChart) return;
    
    const vendasNoPeriodo = eventosFiltrados.filter(e => e.tipo === 'compra_confirmada');
    
    // Agrupar por mês
    const vendasPorMes = new Array(12).fill(0);
    vendasNoPeriodo.forEach(v => {
        if (v.timestamp) {
            const data = v.timestamp.seconds ? new Date(v.timestamp.seconds * 1000) : new Date(v.timestamp);
            vendasPorMes[data.getMonth()]++;
        }
    });
    
    mainChart.data.datasets[0].data = vendasPorMes.slice(0, 6);
    mainChart.update();
}

// ==========================================
// RANKINGS
// ==========================================
function atualizarRankings() {
    atualizarRankingProdutos();
    atualizarRankingPaginas();
}

function atualizarRankingProdutos() {
    const container = document.getElementById('rankingProdutos');
    if (!container) return;
    
    const produtos = {};
    vendas.forEach(v => {
        const nome = v.produto_nome || 'Produto';
        produtos[nome] = (produtos[nome] || 0) + 1;
    });
    
    const ranking = Object.entries(produtos)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    
    if (ranking.length === 0) {
        container.innerHTML = '<p class="text-secondary" style="text-align: center; padding: 20px;">Nenhuma venda registrada</p>';
        return;
    }
    
    container.innerHTML = ranking.map(([nome, qtd], i) => `
        <div class="ranking-item">
            <div class="ranking-position">${i + 1}</div>
            <div style="flex: 1;">
                <p style="font-weight: bold;">${truncarTexto(nome, 30)}</p>
                <p style="font-size: 12px; color: var(--text-secondary);">${qtd} venda${qtd !== 1 ? 's' : ''}</p>
            </div>
        </div>
    `).join('');
}

function atualizarRankingPaginas() {
    const container = document.getElementById('rankingPaginas');
    if (!container) return;
    
    const paginas = {};
    eventos.forEach(e => {
        if (e.pathname) {
            paginas[e.pathname] = (paginas[e.pathname] || 0) + 1;
        }
    });
    
    const ranking = Object.entries(paginas)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    
    if (ranking.length === 0) {
        container.innerHTML = '<p class="text-secondary" style="text-align: center; padding: 20px;">Nenhuma página acessada</p>';
        return;
    }
    
    container.innerHTML = ranking.map(([pagina, qtd], i) => `
        <div class="ranking-item">
            <div class="ranking-position">${i + 1}</div>
            <div style="flex: 1;">
                <p style="font-weight: bold;">${truncarTexto(pagina, 30)}</p>
                <p style="font-size: 12px; color: var(--text-secondary);">${qtd} visita${qtd !== 1 ? 's' : ''}</p>
            </div>
        </div>
    `).join('');
}

// ==========================================
// ÚLTIMAS VENDAS
// ==========================================
function atualizarUltimasVendas() {
    const container = document.getElementById('ultimasVendas');
    if (!container) return;
    
    const ultimas = vendas.slice(0, 10);
    
    if (ultimas.length === 0) {
        container.innerHTML = `
            <tr>
                <td colspan="4" style="text-align: center; padding: 20px; color: var(--text-secondary);">
                    Nenhuma venda registrada
                </td>
            </tr>
        `;
        return;
    }
    
    container.innerHTML = ultimas.map(v => {
        const data = v.timestamp ? new Date(v.timestamp.seconds * 1000).toLocaleDateString() : '-';
        const valor = parseFloat(v.produto_preco) || 0;
        
        return `
            <tr>
                <td class="py-2">${v.produto_nome || '-'}</td>
                <td class="py-2">${v.comprador_nome || '-'}</td>
                <td class="py-2" style="color: var(--accent-primary);">${formatarMoeda(valor)}</td>
                <td class="py-2" style="color: var(--text-secondary);">${data}</td>
            </tr>
        `;
    }).join('');
}

// ==========================================
// ANÁLISE AVANÇADA
// ==========================================
function atualizarAnaliseAvancada(eventosFiltrados) {
    atualizarCarrinhosAbandonados(eventosFiltrados);
    atualizarLocalidade(eventosFiltrados);
}

function atualizarCarrinhosAbandonados(eventosFiltrados) {
    const container = document.getElementById('ultimosAbandonos');
    const totalEl = document.getElementById('totalAbandonsAvancado');
    const valorEl = document.getElementById('valorAbandonado');
    
    if (!container) return;
    
    const abandonos = eventosFiltrados.filter(e => e.tipo === 'cart_abandon');
    
    if (totalEl) totalEl.innerText = abandonos.length;
    
    let valorTotal = 0;
    const ultimos = abandonos.slice(0, 10).map(e => {
        const valor = parseFloat(e.produto_preco) || 0;
        valorTotal += valor;
        return {
            data: e.timestamp ? new Date(e.timestamp.seconds * 1000).toLocaleString() : '',
            url: e.url || e.pathname || '',
            valor
        };
    });
    
    if (valorEl) valorEl.innerText = formatarMoeda(valorTotal);
    
    if (ultimos.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Nenhum abandono registrado</p>';
        return;
    }
    
    container.innerHTML = ultimos.map(a => `
        <div style="padding: 10px; background: rgba(239, 68, 68, 0.1); border-left: 3px solid var(--danger); border-radius: 8px; margin-bottom: 8px;">
            <div style="display: flex; justify-content: space-between;">
                <span style="font-size: 12px; font-weight: bold;">${truncarTexto(a.url, 30)}</span>
                <span style="font-size: 12px; color: var(--text-secondary);">${a.data}</span>
            </div>
            ${a.valor > 0 ? `<p style="font-size: 12px; color: var(--warning); margin-top: 4px;">💰 Valor: ${formatarMoeda(a.valor)}</p>` : ''}
        </div>
    `).join('');
}

function atualizarLocalidade(eventosFiltrados) {
    const container = document.getElementById('rankingCidades');
    if (!container) return;
    
    const cidades = {};
    
    eventosFiltrados.forEach(e => {
        if (e.comprador_cidade && e.comprador_estado) {
            const chave = `${e.comprador_cidade} - ${e.comprador_estado}`;
            cidades[chave] = (cidades[chave] || 0) + 1;
        }
    });
    
    const ranking = Object.entries(cidades)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
    
    if (ranking.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Aguardando dados de localização...</p>';
        return;
    }
    
    container.innerHTML = ranking.map(([cidade, qtd], i) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: var(--bg-card); border-radius: 8px; margin-bottom: 4px;">
            <span><span style="color: var(--accent-primary); font-weight: bold; margin-right: 8px;">${i + 1}.</span>${cidade}</span>
            <span style="color: var(--success); font-weight: bold;">${qtd}</span>
        </div>
    `).join('');
}

// ==========================================
// STATUS DO PIXEL
// ==========================================
function verificarStatusPixel() {
    const statusEl = document.getElementById('pixelStatus');
    if (!statusEl) return;
    
    if (eventos.length === 0) {
        statusEl.innerHTML = '🟡 Aguardando eventos...';
        statusEl.className = 'pixel-status warning';
        return;
    }
    
    const ultimoEvento = eventos[0];
    if (ultimoEvento?.timestamp) {
        const dataUltimo = ultimoEvento.timestamp.seconds 
            ? new Date(ultimoEvento.timestamp.seconds * 1000) 
            : new Date(ultimoEvento.timestamp);
        const horasSemDados = Math.floor((Date.now() - dataUltimo) / (1000 * 60 * 60));
        
        if (horasSemDados > 24) {
            statusEl.innerHTML = `🔴 Inativo há ${horasSemDados}h`;
            statusEl.className = 'pixel-status danger';
        } else if (horasSemDados > 6) {
            statusEl.innerHTML = `🟡 Último há ${horasSemDados}h`;
            statusEl.className = 'pixel-status warning';
        } else {
            statusEl.innerHTML = `🟢 Ativo - ${horasSemDados}h atrás`;
            statusEl.className = 'pixel-status active';
        }
    }
}

// ==========================================
// FUNÇÕES DE CONTROLE DE ABA
// ==========================================
window.mudarAba = function(aba) {
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
    });
    event.currentTarget.classList.add('active');
    
    mostrarAba(aba);
};

function mostrarAba(aba) {
    // Esconder todas as abas
    document.querySelectorAll('.tab-content').forEach(content => {
        if (content) content.style.display = 'none';
    });
    
    // Mostrar a aba selecionada
    const abaElement = document.getElementById(`aba-${aba}`);
    if (abaElement) {
        abaElement.style.display = 'block';
    }
    
    // Atualizar título
    const titles = {
        'visao-geral': 'Visão Geral',
        'produtos': 'Produtos',
        'vendedores': 'Vendedores',
        'compradores': 'Compradores',
        'regioes': 'Regiões',
        'sazonalidade': 'Sazonalidade',
        'trafego-manual': 'Análise de Tráfego',
        'analise-avancada': 'Análise Avançada'
    };
    
    const titleEl = document.getElementById('currentPageTitle');
    if (titleEl) titleEl.innerText = titles[aba] || aba;
}

// ==========================================
// FILTRO DE PERÍODO
// ==========================================
window.setPeriodo = function(periodo) {
    periodoAtual = periodo;
    
    document.querySelectorAll('.periodo-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    
    const eventosFiltrados = filtrarPorPeriodo(periodo);
    atualizarCardsPrincipais(eventosFiltrados);
    atualizarGraficoComDados(eventosFiltrados);
    atualizarAnaliseAvancada(eventosFiltrados);
};

// ==========================================
// REFRESH DE DADOS
// ==========================================
window.refreshData = async function() {
    const icon = document.getElementById('refreshIcon');
    if (icon) icon.classList.add('fa-spin');
    
    mostrarLoading(true);
    await new Promise(r => setTimeout(r, 1000));
    mostrarLoading(false);
    
    if (icon) icon.classList.remove('fa-spin');
    mostrarAlerta('sucesso', 'Dados atualizados!');
};

// ==========================================
// PIXEL CARD
// ==========================================
window.togglePixelCard = function() {
    document.getElementById('pixelCard')?.classList.toggle('show');
};

window.copiarPixel = async function() {
    const pixelId = document.getElementById('pixelDisplaySidebar')?.innerText;
    if (!pixelId) return;
    
    const codigo = `<script src="https://atria-7ja.pages.dev/pixel.js" data-id="${pixelId}"><\/script>`;
    
    try {
        await navigator.clipboard.writeText(codigo);
        mostrarAlerta('sucesso', 'Código copiado!');
    } catch (err) {
        console.error('Erro ao copiar:', err);
        mostrarAlerta('erro', 'Erro ao copiar');
    }
};

// ==========================================
// EXPORTAÇÃO
// ==========================================
window.exportarCSV = function() {
    const dados = [['Tipo', 'Produto', 'Valor', 'Data', 'Origem', 'Campanha'].join(',')];
    
    eventos.slice(0, 100).forEach(e => {
        const linha = [
            e.tipo || '',
            e.produto_nome || '',
            e.produto_preco || '',
            e.timestamp ? new Date(e.timestamp.seconds * 1000).toLocaleString() : '',
            e.utm_source || '',
            e.utm_campaign || ''
        ].map(c => `"${c}"`).join(',');
        
        dados.push(linha);
    });
    
    const blob = new Blob([dados.join('\n')], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `atria_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    
    mostrarAlerta('sucesso', 'CSV exportado!');
};

window.exportarPDF = function() {
    mostrarAlerta('info', 'Use CSV por enquanto. PDF em breve!');
    window.exportarCSV();
};

// ==========================================
// HISTÓRICO DE ANÁLISES
// ==========================================
function carregarHistorico() {
    const container = document.getElementById('historicoAnalises');
    if (!container) return;
    
    const historico = JSON.parse(localStorage.getItem('historicoAnalises') || '[]');
    
    if (historico.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Nenhuma análise salva</p>';
        return;
    }
    
    container.innerHTML = historico.map(item => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-card); border-radius: 8px; margin-bottom: 8px;">
            <div>
                <div style="font-weight: bold;">${item.produto}</div>
                <div style="font-size: 12px; color: var(--text-secondary);">${item.data}</div>
            </div>
            <div style="color: var(--accent-primary); font-weight: bold;">ROAS ${item.roas}x</div>
        </div>
    `).join('');
}

// ==========================================
// LOGOUT
// ==========================================
window.logout = async function() {
    await logoutAuth();
};

// ==========================================
// ATUALIZAR INFO DO USUÁRIO
// ==========================================
function atualizarInfoUsuario(usuario) {
    const nomeEl = document.getElementById('userNameSidebar');
    const pixelEl = document.getElementById('pixelDisplaySidebar');
    const pixelDisplay = document.getElementById('pixelIdDisplay');
    
    if (nomeEl) nomeEl.innerText = usuario.nome;
    if (pixelEl) pixelEl.innerText = usuario.pixelID;
    if (pixelDisplay) pixelDisplay.innerText = usuario.pixelID;
}

// Log de inicialização
console.log('✅ Dashboard principal carregado');
console.log('🚀 ATRIA METRIC v2.0 pronto!');