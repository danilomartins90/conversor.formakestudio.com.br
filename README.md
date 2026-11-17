# conversor.formakestudio.com.br

Conversor de projetos 3MF do Bambu Studio (MakerWorld) para outras impressoras. Roda inteiro no navegador
(HTML, CSS e JS estáticos, publicado no GitHub Pages). O arquivo do usuário não é enviado a nenhum servidor.

## O que a conversão faz

- Copia malhas, pintura, imagens e ajustes por objeto/peça sem alterar.
- Reescreve só `Metadata/project_settings.config` com os perfis do OrcaSlicer da impressora escolhida
  (máquina + processo).
- Compara com o processo da impressora escolhida de mesma qualidade (ex.: `0.20mm Standard`), senão o
  de mesma altura de camada, senão o padrão da impressora. Esse processo não é escolhido na tela.
- Mostra só as configurações de processo em que o original difere desse processo, todas marcadas com o
  valor do original, e o usuário troca as que quiser pelo valor do perfil. As incompatíveis com a
  impressora ficam destacadas e vêm marcadas com o valor do perfil: velocidade, aceleração ou jerk acima
  do máximo da máquina (se mantidas, são limitadas), altura de camada fora do limite do bico
  (`min_layer_height`/`max_layer_height`) e chaves que não existem no OrcaSlicer. Configurações que o
  perfil de destino não define só aparecem se o autor as alterou, porque o valor padrão interno do
  OrcaSlicer não está nos dados gerados.
- As configurações de G-code da aba "Outros" do processo (opções de G-code, formato do nome do arquivo,
  G-code de mudança de tipo de extrusão, scripts de pós-processamento, plugins e notas) não aparecem na
  tabela e saem sempre com o valor da impressora de destino.
- Os filamentos saem iguais ao 3MF original (temperaturas, avanço de pressão, fluxo, ajustes do autor no
  filamento). A troca pelo filamento da impressora é feita no fatiador.
- Reposiciona os objetos de cada mesa no centro da mesa de destino e move a torre de purga junto.
- Impressora sem troca de filamento no OrcaSlicer: junta as cores num filamento e remove a pintura.
- Remove G-code fatiado que venha no 3MF (`Metadata/plate_N.gcode`).

Ao abrir o arquivo, o fatiador procura os presets pelo nome gravado. Se tiver presets com o mesmo nome,
usa os valores dele e mantém só as chaves listadas como ajustes do autor. Se não tiver, usa os valores
gravados no arquivo.

## Limitações

- Impressoras com mais de um bico (H2D, X2D, H2C, IDEX, trocadores de ferramenta) não são listadas.
- Converte o projeto inteiro. Não exporta uma mesa por arquivo.
- Ajustes do autor na impressora de origem não são levados (são mostrados na tela).
- A senha (`js/auth.js`) é só uma barreira visual: o código do site é público.

## Estrutura

```
index.html, style.css      página (mesmo visual da calculadora)
js/auth.js                 portão de senha
js/app.js                  interface
js/converter.js            leitura do 3MF e conversão (sem DOM, roda também no Node)
js/zip.js                  leitura/gravação de ZIP
data/                      perfis gerados a partir do OrcaSlicer
tools/generate-profiles.mjs gerador de data/
```

## Atualizar os perfis

Os dados atuais vêm do OrcaSlicer **v2.5.1** (tag `v2.5.1`, commit `eef7710`). Requer Node 18+ e o código
do [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) na versão desejada. Só são lidas as pastas
`resources/profiles`, `src/libslic3r` e `localization/i18n/pt_BR`, além do `version.inc`:

```bash
git clone --depth 1 --branch v2.5.1 --filter=blob:none --sparse https://github.com/OrcaSlicer/OrcaSlicer.git OrcaSlicer-2.5.1
git -C OrcaSlicer-2.5.1 sparse-checkout set resources/profiles src/libslic3r localization/i18n/pt_BR
node tools/generate-profiles.mjs --orca OrcaSlicer-2.5.1
```

Sem `--orca`, usa `insumos_para_desenvolvimento/OrcaSlicer-2.5.1` (pasta fora do Git). O script lê as listas
de chaves e os rótulos (com a tradução pt_BR) direto do código do OrcaSlicer, resolve `inherits`/`include`
e substitui os `.json` de `data/machines` e `data/processes`.

Depois de mudar arquivos do site, suba o número de versão em todos os lugares onde ele aparece, para
evitar cache antigo: `index.html` (`?version=` e o texto "Versão"), `js/app.js` (`APP_VERSION` e os
`import`) e `js/converter.js` (`import` do `zip.js`). Para conferir: `grep -rn "version=\|APP_VERSION" index.html js`.

## Testar localmente

```bash
python3 -m http.server 8765
```

Abra `http://127.0.0.1:8765/`. Abrir o `index.html` direto do disco não funciona, porque os perfis são
carregados com `fetch`.

## Licença dos dados

Os arquivos de `data/` são derivados dos perfis do OrcaSlicer, distribuídos sob a GNU AGPL-3.0.
