import SwiftUI

struct ReleaseForm:View {
    @EnvironmentObject var api:API;let hold:Row
    @State private var reason="";@State private var key=UUID().uuidString;@State private var saved=false
    var body:some View {Form {Text(hold.text("reason"));TextField("Correction and release reason",text:$reason,axis:.vertical);Button(saved ? "Hold released":"Release hold") {api.run {_ = try await api.action("release",["id":hold.id,"reason":reason],key:key);saved=true}}.disabled(saved||api.working);Text("A passing quality check is still required before the operation can finish.").font(.footnote)}.navigationTitle("Release hold")}
}
struct AliasForm:View {
    @EnvironmentObject var api:API;let stock:Row
    @State private var code="";@State private var scan=false;@State private var saved=false;@State private var key=UUID().uuidString
    var body:some View {Form {Text(stock.text("name"));Text(stock.id);TextField("Barcode value",text:$code).textInputAutocapitalization(.never);Button("Scan barcode") {scan=true};Button(saved ? "Barcode linked":"Link to this exact stock size") {api.run {_ = try await api.action("alias",["code":code,"stock":stock.id],key:key);saved=true}}.disabled(saved||api.working)}.navigationTitle("Link barcode").sheet(isPresented:$scan) {Capture(mode:.barcode) {data,_ in scan=false;do {let codes=try detectBarcodes(data);guard codes.count==1,let c=codes.first else {throw AppError("Frame labels for one stock code only.")};code=c}catch{api.error=error.localizedDescription}}}}
}
struct DeliveryStatus:View {
    @EnvironmentObject var api:API;@State private var entries:[Row]=[]
    var body:some View {List(entries) {r in VStack(alignment:.leading) {Text(r.text("channel")+" · "+r.text("state")).font(.headline);Text(r.id).font(.caption);Text(r.text("receipt")).font(.caption)}}.navigationTitle("Feedback & mail").task {await load()}.refreshable {await load()}}
    func load() async {do {entries=(try await api.request("/api/outbox") as? [[String:Any]] ?? []).map {Row(values:$0)}}catch{api.error=error.localizedDescription}}
}
struct WasteForm:View {
    @EnvironmentObject var api:API;let issue:Row
    @State private var lot="";@State private var quantity="";@State private var reason="";@State private var key=UUID().uuidString;@State private var saved=false
    var body:some View {Form {Picker("Issued lot",selection:$lot) {Text("Choose lot").tag("");ForEach(issue.rows("picks")) {p in Text(p.id).tag(p.id)}};TextField("Spoilt sheets",text:$quantity).keyboardType(.numberPad);TextField("Cause of waste",text:$reason,axis:.vertical);Text("These sheets were already deducted when issued. This records waste without deducting them again.").font(.footnote);Button(saved ? "Waste recorded":"Record waste") {api.run {_ = try await api.action("waste",["issue":issue.id,"lot":lot,"sheets":Int(quantity) ?? 0,"reason":reason],key:key);saved=true}}.disabled(saved||api.working)}.navigationTitle("Issued waste")}
}
