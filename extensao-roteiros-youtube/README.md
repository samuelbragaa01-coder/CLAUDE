# Absorvedor de Roteiros do YouTube (extensão Chrome)

Extrai as transcrições dos vídeos do YouTube e salva em `.md`.

## Instalar
1. Baixe/clone esta pasta.
2. Abra `chrome://extensions`, ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta `extensao-roteiros-youtube`.
4. Recarregue as abas do YouTube que já estavam abertas.

## Usar
**Absorver (canal inteiro):** abra a página do canal (ex.: `youtube.com/@canal`) ou um vídeo dele →
clique no ícone da extensão → defina a **Quantidade** (0 = todos) → **Absorver**.

**Escolher vídeos:** clique em **Iniciar seleção** → clique nas thumbs que quiser (ficam com borda
vermelha e número; clique de novo para desmarcar) → no painel no canto da página, **Baixar selecionados**.
A seleção funciona em qualquer página do YouTube (canal, busca, início, recomendados), e a
"Quantidade" vira o limite de seleção.

## Opções
- **Um .md por vídeo** (salvo em `Downloads/<Canal> - Roteiros/`) ou **tudo em um único .md**.
- **Incluir minutagem**: cada trecho com `[mm:ss]`; sem ela, o texto vira parágrafos corridos.

Vídeos sem legenda/transcrição são pulados e aparecem no log do painel.
