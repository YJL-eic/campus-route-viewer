# 航路结果展示前端（高德地图）

依据根目录 `前端设计.md`：

1. 高德 **三维** 底图 + 建筑楼块 + 三校区起降点 / 中转站  
2. **最快/安全** 路径几何上叠置 **双向双层航道**（红：南→北 210 m；蓝：北→南 160 m）  
3. 起降点绘制终端柱体（R25×H60 / R50×H80），参数来自《终端空域平面与剖面》  
4. 点击起降点进入附近 3D 详情页；设计图暂为占位  

说明：立体航道用 Loca 2.0 LineLayer；同一走廊上下分层，非横向平行双线。无地面投影、无高度夸张按钮。

## 使用步骤

1. 导出航路数据（在项目根目录）：

```bash
cd 三校区货运航路规划
python src/export_web_routes.py
```

2. 在 [高德开放平台](https://console.amap.com/) 创建 **Web 端 JS API Key**，编辑 `config.js`：

```js
amapKey: "你的Key",
amapSecurityCode: "若开启了安全密钥则填写",
```

3. 用本地静态服务打开（高德要求合法来源，不要直接双击 file://）：

```bash
cd web
python -m http.server 8080
```

浏览器访问：http://localhost:8080/

## 按钮含义

| 按钮 | 模型 | 数据文件 |
| --- | --- | --- |
| 最快路线 | 中位风，λP=0，λG=0（仅时间） | `data/routes_fast.json` |
| 安全路线 | 中位风，λP=1，λG=0.5 | `data/routes_safe.json` |

机型默认：丰舟90（20 kg / 70 km）。

## 补充设计图

将图片放到 `assets/`，例如 `assets/main_pad.png`，然后改 `data/nodes.json`：

```json
"design_image": "assets/main_pad.png"
```
