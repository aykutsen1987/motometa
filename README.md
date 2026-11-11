# MotoMeta - Coklu oyuncu sunucusu (Render + GitHub, ucretsiz)

Node.js + WebSocket (`ws`). Odalar, oyuncu listesi, 10 Hz konum aktarimi. **Prototip**: simdilik sunucu konumlari aktarir ve temel dogrulama yapar
(sayi/aralik kirpma, hiz siniri, mesaj hiz siniri). Fizik ve yaris sonucu dogrulamasi sonraki surumde.

## Render'a yukleme (adim adim)

1. Projeyi (veya sadece `Server` klasorunu) bir **GitHub** deposuna yukle.
2. render.com > **New > Blueprint** > depoyu sec (`Server/render.yaml` okunur). Ya da **New > Web Service**:
   Root Directory `Server`, Build `npm install`, Start `node server.js`, Plan **Free**.
3. Yayinlaninca `https://motometa-server-xxxx.onrender.com` gibi bir adres verilir.
4. Oyunda: **Cok Oyunculu > Sunucu adresi** alanina bu adresi yaz (`https://` otomatik `wss://` olur) > **BAGLAN**.

Ucretsiz plan ~15 dk istek gelmezse uyur; ilk baglanti 30-60 sn surer (oyun 95 sn boyunca otomatik yeniden dener). Kalici disk yoktur.

## Yerel test
```
cd Server
npm install
npm start            # :8080
PORT=18080 node server.js &  &&  PORT=18080 npm test    # otomatik test: PASS bekleyin
```

## Protokol (JSON, WebSocket)
Istemci > sunucu: `hello{name,bike}`, `list`, `quick`, `create{name,max}`, `join{room}`, `leave`, `s{x,y,z,ry,lz,sp,st}`, `ping`.
Sunucu > istemci: `welcome{id}`, `rooms{rooms[]}`, `joined{room,you,players[]}`, `pj{id,name,bike}`, `pl{id}`, `snap{p[]}`, `err{m}`, `pong`.
