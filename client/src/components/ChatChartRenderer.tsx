// Lazily-loaded chart body for chat messages.
// This file owns the recharts dependency so the eager chat page (home route)
// doesn't pull recharts into the main bundle — it is only fetched when a
// message actually contains a chart.
import {
  PieChart, Pie, Cell,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Label, LabelList,
} from "recharts";

// Chart types (inline — schema was reverted)
export type ChartType2 = "line"|"bar"|"area"|"pie"|"scatter"|"composed"|"radar";
export interface ChartSeries2 { dataKey:string; name:string; color?:string; type?:"line"|"bar"|"area"; stackId?:string; }
export interface ChartKpi2 { label:string; value:string; }
export interface ChartSpec2 { type:ChartType2; title:string; subtitle?:string; data:Array<Record<string,any>>; series:ChartSeries2[]; xAxisKey:string; xAxisLabel?:string; yAxisLabel?:string; showLegend?:boolean; showGrid?:boolean; height?:number; nameKey?:string; valueKey?:string; unit?:string; notes?:string[]; confidence?:number; showValueLabels?:boolean; kpis?:ChartKpi2[]; }

const CHART_PALETTE = ["hsl(188 55% 50%)","#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#84cc16"];

export default function ChatChartBody({ spec }: { spec: ChartSpec2 }) {
  const h = spec.height || 260;
  const tts = { backgroundColor:"hsl(var(--card))", border:"1px solid hsl(var(--border))", borderRadius:8, color:"hsl(var(--foreground))", fontSize:12 };
  // Format a tooltip value with the chart's unit ("170 g", "$42.50", "—" for gaps).
  const fmtVal = (v:any, name:any):[string,string] => {
    if (v == null) return ["—", name];
    const u = spec.unit;
    if (u === "$") return [`$${Number(v).toLocaleString(undefined,{maximumFractionDigits:2})}`, name];
    return [u ? `${v} ${u}` : String(v), name];
  };

  function renderChart() {
    if (spec.type==="pie") {
      // Pie label heuristic:
      //  - outerRadius lowered to 62% so the surrounding label text stays
      //    inside the chart frame (was 75%, which clipped long category
      //    names like "general" → "gene" on narrow containers).
      //  - drop labels for slices under 9% to prevent neighbouring labels
      //    overlapping (the slice still appears in the legend below).
      //  - render category name + percent with a hair-space separator so
      //    it doesn't break mid-word when the slice arc is short.
      return (
        <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <Pie
            data={spec.data}
            dataKey={spec.valueKey||"amount"}
            nameKey={spec.nameKey||"category"}
            cx="50%"
            cy="50%"
            outerRadius="62%"
            label={({name,percent}:{name:string;percent:number})=>percent>=0.09?`${name} · ${(percent*100).toFixed(0)}%`:""}
            labelLine={false}
          >
            {spec.data.map((e,i)=><Cell key={i} fill={e.fill||CHART_PALETTE[i%CHART_PALETTE.length]}/>)}
          </Pie>
          <Tooltip contentStyle={tts} formatter={(v:any)=>[typeof v==="number"?`$${Number(v).toFixed(2)}`:v,""]}/>
          {spec.showLegend!==false&&<Legend/>}
        </PieChart>
      );
    }
    if (spec.type==="radar") {
      return (
        <RadarChart data={spec.data} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke="hsl(var(--border))"/>
          <PolarAngleAxis dataKey={spec.xAxisKey} tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}/>
          {spec.series.map((s,i)=><Radar key={i} name={s.name} dataKey={s.dataKey} stroke={s.color||CHART_PALETTE[i]} fill={s.color||CHART_PALETTE[i]} fillOpacity={0.25}/>)}
          <Tooltip contentStyle={tts}/>
        </RadarChart>
      );
    }
    if (spec.type==="bar") {
      return (
        <BarChart data={spec.data} barCategoryGap="30%" margin={{ top: 18, right: 12, bottom: spec.xAxisLabel?18:4, left: spec.yAxisLabel?10:0 }}>
          {spec.showGrid!==false&&<CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false}/>}
          <XAxis dataKey={spec.xAxisKey} tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}} interval="preserveStartEnd" allowDuplicatedCategory={false}>
            {spec.xAxisLabel&&<Label value={spec.xAxisLabel} position="insideBottom" offset={-8} style={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}/>}
          </XAxis>
          <YAxis tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}>
            {spec.yAxisLabel&&<Label value={spec.yAxisLabel} angle={-90} position="insideLeft" style={{fontSize:11,fill:"hsl(var(--muted-foreground))",textAnchor:"middle"}}/>}
          </YAxis>
          <Tooltip contentStyle={tts} formatter={fmtVal}/>
          {spec.series.map((s,i)=>(
            <Bar key={i} dataKey={s.dataKey} name={s.name} fill={s.color||CHART_PALETTE[i]} radius={[3,3,0,0] as any}>
              {spec.showValueLabels&&<LabelList dataKey={s.dataKey} position="top" style={{fontSize:10,fill:"hsl(var(--foreground))"}} formatter={(v:any)=>v==null?"":v}/>}
            </Bar>
          ))}
          {spec.showLegend&&<Legend/>}
        </BarChart>
      );
    }
    if (spec.type==="area") {
      return (
        <AreaChart data={spec.data}>
          {spec.showGrid!==false&&<CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"/>}
          <XAxis dataKey={spec.xAxisKey} tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}} interval="preserveStartEnd" allowDuplicatedCategory={false}/>
          <YAxis tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}/>
          <Tooltip contentStyle={tts}/>
          {spec.series.map((s,i)=><Area key={i} type="monotone" dataKey={s.dataKey} name={s.name} stroke={s.color||CHART_PALETTE[i]} fill={s.color||CHART_PALETTE[i]} fillOpacity={0.15} strokeWidth={2}/>)}
          {spec.showLegend&&<Legend/>}
        </AreaChart>
      );
    }
    // Default: line
    return (
      <LineChart data={spec.data} margin={{ top: 18, right: 12, bottom: spec.xAxisLabel?18:4, left: spec.yAxisLabel?10:0 }}>
        {spec.showGrid!==false&&<CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"/>}
        <XAxis dataKey={spec.xAxisKey} tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}} interval="preserveStartEnd" allowDuplicatedCategory={false}>
          {spec.xAxisLabel&&<Label value={spec.xAxisLabel} position="insideBottom" offset={-8} style={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}/>}
        </XAxis>
        <YAxis tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}>
          {spec.yAxisLabel&&<Label value={spec.yAxisLabel} angle={-90} position="insideLeft" style={{fontSize:11,fill:"hsl(var(--muted-foreground))",textAnchor:"middle"}}/>}
        </YAxis>
        <Tooltip contentStyle={tts} formatter={fmtVal}/>
        {spec.series.map((s,i)=>(
          <Line key={i} type="monotone" dataKey={s.dataKey} name={s.name} stroke={s.color||CHART_PALETTE[i]} strokeWidth={2.5} dot={{r:3}} activeDot={{r:5}} connectNulls={false}>
            {spec.showValueLabels&&<LabelList dataKey={s.dataKey} position="top" style={{fontSize:10,fill:"hsl(var(--foreground))"}} formatter={(v:any)=>v==null?"":v}/>}
          </Line>
        ))}
        {spec.showLegend&&<Legend/>}
      </LineChart>
    );
  }

  return <ResponsiveContainer width="100%" height={h}>{renderChart()}</ResponsiveContainer>;
}
