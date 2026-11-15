# 미리온 (MiriOn)

도착할 때까지 실내 온도와 김서림, CO2를 미리 계산해서 같은 쾌적함을 더 적은 공조 전력으로 만드는 전기차 공조 앱입니다. 같은 차량 데이터로 교량과 고가의 노면 결빙 가능성도 확률로 알려 줍니다.

팀: 최형우, 김종헌

## 실행 방법

### 시뮬레이터 (바로 실행)

`demo/index.html`을 Chrome에서 열면 됩니다. 서버나 설치가 필요 없습니다.

화면에서 할 수 있는 것:

1. 주행 조건(겨울 출근, 여름 땡볕 주차 후, 겨울 가족 장거리)과 외기 온도, 탑승 인원을 바꿔 기준 자동 공조와 미리온을 비교합니다.
2. 노면 결빙 추정에서 외기 온도, 시각, 하늘, 습도를 바꿔 결빙 확률이 어떻게 달라지는지 봅니다.
3. 안전 게이트에서 차량 상태를 바꾼 뒤 명령 버튼을 눌러 통과, 보정, 거부 판정을 확인합니다.

### 엔진 테스트와 수치 재생성

Node.js 20 이상이 필요하고 외부 라이브러리는 쓰지 않습니다.

```
npm test            # 자동 테스트 40개, 약 14초
npm run results     # 기획서 수치를 docs/results.json으로 다시 계산, 약 1분
npm run build       # src를 demo/index.html과 android/app/src/main/assets/car.html로 묶기
```

### Android 앱 (Pleos Connect)

`android/` 폴더를 Android Studio에서 열어 빌드합니다. Pleos Vehicle SDK 2.3.2(`ai.pleos.playground:Vehicle:2.3.2`)를 Pleos Playground Maven 저장소에서 받도록 `settings.gradle.kts`에 설정해 두었습니다. Gradle 래퍼는 들어 있지 않으니 Android Studio에서 프로젝트를 열 때 생성하면 됩니다.

앱은 WebView에 `assets/car.html`을 띄우고, Kotlin 코드가 차량 신호를 읽어 엔진에 넘깁니다. 엔진이 낸 명령 가운데 안전 게이트를 통과한 것만 차로 보냅니다. 자동 적용은 기본으로 꺼져 있습니다.

## 테스트 환경과 필요한 설정

| 항목 | 내용 |
| --- | --- |
| 엔진, 테스트 | Node.js 22, Linux |
| 시뮬레이터 | Chrome, 화면 폭 1100px과 400px에서 확인 |
| 차 안 화면 `car.html` | 차 밖에서 열면 가상 신호로 동작하며, 스크립트 오류가 없는 것을 확인 |
| Android 빌드 | Android Studio, compileSdk 34, minSdk 28, Kotlin 1.9.24, AGP 8.5.2 |

앱이 요청하는 권한은 `AndroidManifest.xml`에 있습니다.

| 권한 | 쓰임 |
| --- | --- |
| `pleos.car.permission.CAR_CLIMATE`, `CONTROL_CAR_CLIMATE` | 실내 온도, 설정 온도, 내기 순환, 송풍 읽기와 조절 |
| `pleos.car.permission.CAR_ENERGY` | 배터리 잔량, 충전 여부 |
| `pleos.car.permission.CAR_SEATS`, `CONTROL_CAR_SEATS` | 좌석별 착석, 시트 열선 읽기와 조절 |
| `android.car.permission.CAR_SPEED`, `CAR_EXTERIOR_ENVIRONMENT`, `CAR_POWERTRAIN` | 속도, 외기 온도, 기어 |

## 사용한 Pleos API

| 신호 | API |
| --- | --- |
| 실내 온도 | `HVAC.getHvacTemperatureCurrent` |
| 설정 온도 읽기, 바꾸기 | `HVAC.getHvacTemperature`, `HVAC.setHvacTemperature` |
| 내기 순환 읽기, 켜기와 끄기 | `HVAC.getHvacRecirculationState`, `HVAC.setHvacRecirculation` |
| 송풍 단수 | `HVAC.getHvacFanSpeed` |
| 배터리 잔량, 충전 중 여부 | `EvBattery.getEvBatteryStateOfCharge`, `EvBattery.getEvChargeSwitchState` |
| 좌석별 착석 | `Seat.getCurrentSeatOccupancy` |
| 시트 열선 읽기, 바꾸기 | `Seat.getHvacSeatTemperature`, `Seat.setHvacSeatTemperature` |

속도, 외기 온도, 기어는 Pleos Vehicle SDK 문서에서 대응하는 API를 찾지 못해 Android Automotive 표준 속성으로 읽습니다.

## Pleos Connect 에뮬레이터 버전과 화면 규격

1차 제출 시점에는 Pleos Connect 에뮬레이터에서 실행하지 못했습니다. 2차 PT 전까지 에뮬레이터에서 빌드와 실행을 마치고, 사용한 에뮬레이터 버전과 화면 규격을 이 항목에 적겠습니다.

## APK 위치

1차 제출에는 APK가 없습니다. 빌드한 뒤 `apk/팀명_앱이름_release.apk` 형식으로 `apk/` 폴더에 넣겠습니다.

## 폴더 구성

| 경로 | 내용 |
| --- | --- |
| `src/thermal.js` | 실내 열, 습기, CO2 모델(공기, 내장재, 앞유리, 옆·뒷유리, 외판)과 수반(adjoint) 계산 |
| `src/comfort.js` | 체감온도(등가온도)와 쾌적 대역 |
| `src/mpc.js` | 도착 시각까지 내다보는 예측 제어 |
| `src/gate.js` | 안전 게이트 |
| `src/verify.js` | 게이트 전수 검사(불변식 11개) |
| `src/blackice.js` | 노면 결빙 확률 추정 |
| `src/calibrate.js` | 실측 온도로 열 특성 계수 보정 |
| `src/scenario.js` | 주행 시나리오와 기준 공조 비교 |
| `src/runtime.js` | 차량 신호를 받아 제안 카드, 결빙 안내, 차량 명령을 내는 실행 계층 |
| `demo/` | 단일 파일 시뮬레이터 |
| `android/` | Pleos Connect용 Android 앱 소스 |
| `docs/results.json` | 기획서에 쓴 수치의 원본 |

## 수치에 대해

모든 수치는 모델로 계산한 추정이며 실차 측정값이 아닙니다. 절감률은 차량 열 계수 ±20%, 기준 공조의 내기 순환 20~70%, 앞유리 풍량 0~30%, 열선 사용 여부를 바꾼 60가지 경우의 10~90% 범위로 보고합니다. 노면 결빙 확률은 노면 온도를 재지 않고 추정한 값이라, 확률이 낮아도 안전하다는 뜻은 아닙니다.
